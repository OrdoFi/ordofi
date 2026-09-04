import { createServer } from "node:http";
import { landingHtml } from "./landing.ts";
import { join } from "node:path";
import { ENDPOINTS, isRetryableRpcError, rpcFetch, rpcOnce, rpcUrls, sendRawTransaction, sequencerUrl } from "@ordofi/core";
import { OrdoStore } from "@ordofi/store";
import { CONFIG, loadApiKeys, RateLimiter, type ApiKey } from "./config.js";
import { RpcError } from "./errors.js";
import { Metrics } from "./metrics.js";
import { bundlerInfo, protectAndSend, sendBundle, simulateRaw } from "./protect.js";
import { DEFAULT_TRACKED, MarketCaps } from "./mcap.js";
import { routeOrderFlow } from "./orderflow.js";
import { prewarm as prewarmSwapRoutes, quoteSwap } from "./ordoswap2.js";
import { swapHtml } from "./swap-page.js";
import { SwapStats } from "./swapstats.js";
import { TokenList } from "./tokens.js";
import {
  BLOCK_MS,
  HedgeBudget,
  IDEMPOTENT_READS,
  InflightCap,
  MicroCache,
  cacheKey,
  cacheTtlMs,
  clientIp,
  hedged,
  staticAnswer,
} from "./fastpath.js";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { callOrigin, forwardHeaders, type OriginReply } from "./edge.js";

const UPSTREAM = ENDPOINTS.rpc;
const apiKeys = loadApiKeys();
const limiter = new RateLimiter();
const sendLimiter = new RateLimiter();
const inflight = new InflightCap(CONFIG.anonMaxInflight);
const hedgeBudget = new HedgeBudget(CONFIG.hedgeBudgetRatio);
const cache = new MicroCache();

// Self-serve keys minted by the portal live in the shared index, hashed. The
// env list stays authoritative for operator-configured keys; the store is the
// fallback, and hits are cached in the same map so the hash is computed once
// per key, not per request.
let store: OrdoStore | null = null;
try {
  store = new OrdoStore(process.env.ORDO_DB ?? join(import.meta.dirname, "../../../data/ordo.db"));
} catch (e) {
  console.warn(`gateway | portal keys unavailable (${(e as Error).message})`);
}

/**
 * Store-backed keys are re-read periodically rather than remembered for the
 * life of the process. Caching them forever meant that raising a partner's
 * rate limit — the fix for the one incident this cache is implicated in — did
 * not take effect until the next deploy. A minute of staleness is nothing; a
 * limit that cannot be changed without a rollout is a problem.
 */
const KEY_TTL_MS = 60_000;
const keySeenAt = new Map<string, number>();

function storeBackedKey(presented: string): ApiKey | null {
  if (!store) return null;
  try {
    const row = store.findApiKey(presented);
    if (!row) return null;
    const key: ApiKey = {
      key: presented,
      label: row.label,
      rateLimit: row.rateLimit,
      rebateAddress: row.rebateAddress,
      mode: row.mode,
    };
    apiKeys.set(presented, key);
    keySeenAt.set(presented, Date.now());
    return key;
  } catch {
    return null;
  }
}
const metrics = new Metrics();

/**
 * What the gateway can answer without leaving the process: constants of the
 * deployment and reads still inside their cache window. Consulted before the
 * rate limiter, so a wallet's polling never counts against its owner.
 */
function localAnswer(method: string, params: unknown[]): unknown | undefined {
  const fixed = staticAnswer(method, CONFIG.chainId);
  if (fixed !== undefined) {
    metrics.inc("rpc_local_total", { method, source: "static" });
    return fixed;
  }
  const hit = cache.get(cacheKey(method, params));
  if (hit !== undefined) metrics.inc("rpc_local_total", { method, source: "cache" });
  return hit;
}

/**
 * One read, actually sent. rpcFetch rotates across ORDO_RPC_URLS on transport
 * failures (403 challenge pages, timeouts) and rethrows genuine JSON-RPC
 * errors with their code — those come from a healthy upstream and must not
 * rotate. When there is a second upstream, a slow answer from the first is
 * hedged to it and whichever replies first wins. Reads only: a send hedged
 * twice is a transaction submitted twice.
 */
async function fetchUpstream(method: string, params: unknown[]): Promise<unknown> {
  const urls = rpcUrls();
  if (!IDEMPOTENT_READS.has(method) || urls.length < 2 || CONFIG.hedgeAfterMs <= 0) {
    return rpcFetch(method, params);
  }
  hedgeBudget.read();
  return hedged(
    () => rpcFetch(method, params),
    () => rpcOnce(urls[1], method, params),
    CONFIG.hedgeAfterMs,
    (ev) => metrics.inc(`hedge_${ev}_total`),
    () => hedgeBudget.tryHedge(),
  );
}

async function upstream(method: string, params: unknown[]): Promise<any> {
  const started = Date.now();
  try {
    // Signed transactions go to the sequencer operator's endpoint and nowhere
    // else unless it is down; a third-party provider must not see them first.
    if (method === "eth_sendRawTransaction") {
      return await sendRawTransaction(params[0] as string, {
        onFallback: (reason) => {
          metrics.inc("send_fallback_total");
          console.warn(`gateway | sequencer endpoint unavailable (${reason}) — send fell back to the provider list`);
        },
      });
    }
    const local = localAnswer(method, params);
    if (local !== undefined) return local;
    if (!IDEMPOTENT_READS.has(method)) return await fetchUpstream(method, params);
    // Identical concurrent reads share one upstream call, and the answer is
    // kept for as long as it can be exact (a block for the head, forever for
    // a mined receipt, not at all for eth_call).
    return await cache.through(
      cacheKey(method, params),
      () => fetchUpstream(method, params),
      (result) => cacheTtlMs(method, params, result),
    );
  } catch (e) {
    // A provider's own throttle wording ("exceeded the RPS limit on the current
    // plan") is about our contract with them, not the user's request, and must
    // never reach a wallet. If every upstream is busy, say so in our words with
    // the standard "limit exceeded" code that clients back off and retry on.
    if (isRetryableRpcError(e)) {
      metrics.inc("upstream_throttled_total");
      throw new RpcError(-32005, "the network is busy, please try again in a moment");
    }
    // A real answer from a healthy upstream, code and data intact. The data is
    // the revert reason — the one thing a wallet can show for a failed
    // eth_call or eth_estimateGas — and used to be lost right here.
    const code = (e as { code?: number }).code;
    if (typeof code === "number") throw new RpcError(code, (e as Error).message, (e as { data?: unknown }).data);
    metrics.inc("upstream_challenge_total");
    throw new RpcError(-32000, `all RPC upstreams refused the request — ${(e as Error).message}`);
  } finally {
    metrics.observe("upstream_latency_ms", Date.now() - started);
  }
}

/**
 * Remember what went through us. This is the public "volume routed" counter:
 * the row is written the moment a hash comes back, and the web app fills in
 * the receipt and the value later. Best-effort — a bookkeeping failure must
 * never fail a user's transaction.
 */
async function recordRouted(txHash: string, rawTx: string, keyLabel: string, via: string): Promise<void> {
  if (!store || typeof txHash !== "string" || !txHash.startsWith("0x")) return;
  try {
    const tx = parseTransaction(rawTx as TransactionSerialized);
    const sender = await recoverTransactionAddress({ serializedTransaction: rawTx as TransactionSerialized }).catch(() => null);
    store.recordRouted({ txHash, sender, target: tx.to ?? null, valueWei: tx.value ?? 0n, keyLabel, via });
  } catch (e) {
    console.warn(`gateway | could not record routed tx ${txHash}: ${(e as Error).message}`);
  }
}

async function dispatch(method: string, params: unknown[], apiKey: ApiKey): Promise<any> {
  switch (method) {
    case "eth_sendRawTransaction": {
      metrics.inc("tx_submitted_total", { key: apiKey.label });
      const raw = params[0] as string;
      // Keys configured for order flow get the auction; everyone else gets a
      // revert-protected direct send.
      if (apiKey.mode !== "auction") {
        const hash = await protectAndSend(upstream, raw);
        void recordRouted(hash, raw, apiKey.label, "protect");
        return hash;
      }
      const out = await routeOrderFlow(upstream, raw, apiKey);
      metrics.inc(out.auctioned ? "orderflow_auctioned_total" : "orderflow_fallback_total", {
        key: apiKey.label,
      });
      if (!out.auctioned) console.warn(`gateway | auction unavailable (${out.reason}) — sent direct`);
      void recordRouted(out.txHash, raw, apiKey.label, out.auctioned ? "auction" : "protect");
      return out.txHash;
    }
    // Always auction, regardless of how the key is configured.
    case "ordo_sendPrivateTransaction": {
      metrics.inc("tx_submitted_total", { key: apiKey.label });
      const raw = params[0] as string;
      const out = await routeOrderFlow(upstream, raw, apiKey);
      metrics.inc(out.auctioned ? "orderflow_auctioned_total" : "orderflow_fallback_total", {
        key: apiKey.label,
      });
      void recordRouted(out.txHash, raw, apiKey.label, out.auctioned ? "auction" : "protect");
      return out.txHash;
    }
    case "ordo_simulate":
      return simulateRaw(upstream, params[0] as string);
    case "ordo_sendBundle": {
      metrics.inc("bundle_submitted_total", { key: apiKey.label });
      const bundle = params[0] as { txs: string[]; allowRevert?: boolean | number[] };
      const out = await sendBundle(upstream, bundle);
      out.txHashes.forEach((h: string, i: number) => void recordRouted(h, bundle.txs[i], apiKey.label, "bundle"));
      return out;
    }
    case "ordo_bundlerInfo":
      return bundlerInfo(upstream, params[0] as string);
    case "ordo_quoteSwap": {
      if (!CONFIG.ordoSwapAddress) throw new RpcError(-32601, "ordo_quoteSwap is not enabled on this gateway (ORDO_SWAP_ADDRESS unset)");
      const p = (params[0] ?? {}) as Record<string, unknown>;
      const addr = (v: unknown, name: string): `0x${string}` => {
        if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new RpcError(-32602, `ordo_quoteSwap: ${name} must be an address`);
        return v as `0x${string}`;
      };
      const big = (v: unknown, name: string, optional = false): bigint => {
        if (v === undefined || v === null) {
          if (optional) return 0n;
          throw new RpcError(-32602, `ordo_quoteSwap: ${name} is required`);
        }
        try {
          return BigInt(v as string);
        } catch {
          throw new RpcError(-32602, `ordo_quoteSwap: ${name} must be a number (hex or decimal string)`);
        }
      };
      metrics.inc("swap_quote_total", { key: apiKey.label });
      return quoteSwap(
        {
          tokenIn: addr(p.tokenIn, "tokenIn"),
          tokenOut: addr(p.tokenOut, "tokenOut"),
          amountIn: big(p.amountIn, "amountIn"),
          amountOutMinimum: big(p.amountOutMinimum, "amountOutMinimum", true),
          recipient: addr(p.recipient, "recipient"),
          nativeOut: Boolean(p.nativeOut),
          from: p.from === undefined ? undefined : addr(p.from, "from"),
          skipReclaim: Boolean(p.skipReclaim),
        },
        // V4 pools come from the watcher's index in the shared store; without it
        // (a bare dev box) the quote still covers every V3 market.
        { rpc: upstream, ordoSwap: CONFIG.ordoSwapAddress as `0x${string}`, v4: store },
      );
    }
    default:
      return upstream(method, params);
  }
}

/**
 * Edge mode (CONFIG.edgeOrigin set): answer from memory when the answer is
 * in memory, otherwise forward to the origin gateway as the client sent it and
 * return exactly what it said. Idempotent reads that miss are fetched through
 * the origin once for all concurrent callers and cached here for their usual
 * window, so the second wallet asking for the head block does not cross the
 * ocean either. Authentication and limits are the origin's: the key header
 * and the client's address travel with the request.
 */
async function edgeAnswer(
  msg: { id?: unknown },
  method: string,
  params: unknown[],
  req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
): Promise<object> {
  const keyed = Boolean(req.headers["x-api-key"] || req.headers.authorization);
  const plainRead = !method.startsWith("ordo_") && method !== "eth_sendRawTransaction";
  if (plainRead && (keyed || CONFIG.allowAnon)) {
    const local = localAnswer(method, params);
    if (local !== undefined) return { jsonrpc: "2.0", id: msg.id, result: local };
  }
  const headers = forwardHeaders(req.headers, clientIp(req));
  metrics.inc("rpc_edge_forwarded_total", { method });
  const started = Date.now();
  const call = () => callOrigin(CONFIG.edgeOrigin, method, params, msg.id, headers);
  let reply: OriginReply;
  try {
    if (plainRead && IDEMPOTENT_READS.has(method)) {
      // The cache holds results, the same shape localAnswer hands out.
      const result = await cache.through(
        cacheKey(method, params),
        async () => {
          const r = await call();
          // An error is an answer for this caller, not a fact about the chain.
          if (r.error) throw Object.assign(new Error(r.error.message), { reply: r });
          return r.result;
        },
        (v) => cacheTtlMs(method, params, v),
      );
      reply = { result };
    } else {
      reply = await call();
    }
  } catch (e) {
    reply = (e as { reply?: OriginReply }).reply ?? {
      error: { code: -32000, message: `origin gateway unreachable — ${(e as Error).message}` },
    };
  } finally {
    metrics.observe("upstream_latency_ms", Date.now() - started);
  }
  if (reply.error) {
    metrics.inc("rpc_errors_total", { method });
    return { jsonrpc: "2.0", id: msg.id, error: reply.error };
  }
  return { jsonrpc: "2.0", id: msg.id, result: reply.result };
}

function authenticate(
  req: { headers: Record<string, string | string[] | undefined> },
  method: string,
): ApiKey | "anon" | null {
  const header =
    (req.headers["x-api-key"] as string) ??
    (typeof req.headers.authorization === "string"
      ? req.headers.authorization.replace(/^Bearer\s+/i, "")
      : undefined);

  if (header && apiKeys.has(header)) {
    // Operator keys from the env list are authoritative and never re-read;
    // ones that came from the store go stale so a changed limit lands.
    const seen = keySeenAt.get(header);
    if (seen === undefined || Date.now() - seen < KEY_TTL_MS) return apiKeys.get(header)!;
  }
  if (header) {
    const fromStore = storeBackedKey(header);
    if (fromStore) return fromStore;
    if (apiKeys.has(header)) return apiKeys.get(header)!; // store unreachable: keep serving
  }
  if (CONFIG.allowAnon && CONFIG.anonMethods.has(method)) return "anon";
  return null;
}

const LANDING = landingHtml({
  chainId: CONFIG.chainId,
  explorer: "https://robinhoodchain.blockscout.com",
  docs: "https://app.ordofi.network/docs",
  portal: "https://app.ordofi.network/portal",
  app: "https://app.ordofi.network",
});

// Ordo Swap's home: the page, and the tally behind it. Only when the contract
// is configured; otherwise /swap says so rather than showing an empty product.
const SWAP_PAGE = CONFIG.ordoSwapAddress
  ? swapHtml({
      address: CONFIG.ordoSwapAddress,
      explorer: "https://robinhoodchain.blockscout.com",
      rpc: "https://rpc.ordofi.network",
      app: "https://app.ordofi.network",
      docs: "https://app.ordofi.network/docs",
      proofTx: process.env.ORDO_SWAP_PROOF_TX ?? "0xd3402046255c3f0b954989660d3faae2c39a46930fd442f813e39b116b8d0641",
    })
  : null;
const swapStats = CONFIG.ordoSwapAddress
  ? new SwapStats(
      (m, p) => upstream(m, p),
      // The live contract first, then the ones it replaced: their swaps happened too.
      [CONFIG.ordoSwapAddress, ...CONFIG.ordoSwapPast] as `0x${string}`[],
      Number(process.env.ORDO_SWAP_FROM_BLOCK ?? 54_397_000),
      // Same volume as the key index and the receipt log (ORDO_DATA_DIR in production).
      join(process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data"), "swap-stats.json"),
    )
  : null;
if (swapStats && !CONFIG.edgeOrigin) {
  const tick = () => swapStats.refresh().catch((e) => console.warn(`gateway | swap stats: ${(e as Error).message}`));
  setTimeout(tick, 3_000).unref();
  setInterval(tick, 30_000).unref();
}
// The picker's token list, refreshed from the app every minute. Caps are worked
// out on the side (supply and, for the launchpad tokens the app cannot price, a
// pool's spot price) and fold into the list as they arrive. Edges neither quote
// nor read the chain for this; only the origin does.
const marketCaps = CONFIG.ordoSwapAddress && !CONFIG.edgeOrigin ? new MarketCaps((m, p) => upstream(m, p), store) : null;
const tokenList = CONFIG.ordoSwapAddress
  ? new TokenList(process.env.ORDO_TOKEN_LIST_URL ?? "https://app.ordofi.network/api/trade/tokens", fetch, store, marketCaps)
  : null;
if (tokenList) {
  const tick = () => tokenList.refresh().catch((e) => console.warn(`gateway | token list: ${(e as Error).message}`));
  tick();
  setInterval(tick, 60_000).unref();
  // Once the list is in, keep the markets of the 150 busiest tokens warm so
  // their first quote never pays for discovery. Origin only; edges do not quote.
  if (!CONFIG.edgeOrigin) {
    setTimeout(() => prewarmSwapRoutes((m, p) => upstream(m, p), store, () => tokenList.top(150) as `0x${string}`[]), 5_000).unref();
  }
  if (marketCaps) {
    const caps = () => marketCaps.refresh(tokenList.ranked(DEFAULT_TRACKED), tokenList.ethUsd()).catch((e) => console.warn(`gateway | market caps: ${(e as Error).message}`));
    setTimeout(caps, 20_000).unref();
    setInterval(caps, 5 * 60_000).unref();
  }
}

let stopping = false;

const server = createServer((req, res) => {
  // The path alone: a shared link like /swap?ref=x or /swap#eth must still be the swap page.
  const url = (req.url ?? "/").split(/[?#]/, 1)[0] || "/";

  // Browser dapps call the RPC straight from the page; wallets do not need
  // this, but nothing here is origin-sensitive, so allow it.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, x-api-key, authorization");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
    res.end(LANDING);
    return;
  }
  if (req.method === "GET" && (url === "/swap" || url === "/swap/")) {
    if (!SWAP_PAGE) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Ordo Swap is not enabled on this gateway");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" });
    res.end(SWAP_PAGE);
    return;
  }
  if (req.method === "GET" && url === "/swap/tokens") {
    if (!tokenList) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Ordo Swap is not enabled on this gateway" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
    res.end(tokenList.body());
    return;
  }
  if (req.method === "GET" && url === "/swap/stats") {
    if (!swapStats) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Ordo Swap is not enabled on this gateway" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=15" });
    res.end(JSON.stringify(swapStats.totals()));
    return;
  }
  if (req.method === "GET" && url === "/health") {
    // 503 while draining: the edge's health check drops this replica before
    // the listener closes, so nothing is routed here in its last seconds.
    res.writeHead(stopping ? 503 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: stopping ? "draining" : "ok",
        role: CONFIG.edgeOrigin ? "edge" : "origin",
        ...(CONFIG.edgeOrigin ? { origin: CONFIG.edgeOrigin } : {}),
        upstream: UPSTREAM,
        sequencer: sequencerUrl(),
        uptimeSeconds: metrics.json().uptimeSeconds,
        cacheEntries: cache.size,
      }),
    );
    return;
  }
  if (req.method === "GET" && url === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(metrics.prometheus());
    return;
  }
  if (req.method === "GET" && url === "/metrics.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(metrics.json(), null, 2));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(req.method === "GET" ? 404 : 405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "JSON-RPC is served over POST; see https://rpc.ordofi.network/ for usage" }));
    return;
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const started = Date.now();
    res.setHeader("content-type", "application/json");
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }

    const batch = Array.isArray(payload) ? payload : [payload];
    const results = await Promise.all(
      batch.map(async (msg) => {
        const method = msg.method ?? "";
        metrics.inc("rpc_requests_total", { method });

        const params: unknown[] = Array.isArray(msg.params) ? msg.params : [];
        if (CONFIG.edgeOrigin) return edgeAnswer(msg, method, params, req);

        const auth = authenticate({ headers: req.headers }, method);
        if (!auth) {
          metrics.inc("rpc_unauthorized_total", { method });
          // Two different situations share this branch and deserve different
          // words: a key was presented and is wrong, or no key was presented
          // and the method is one of the few not open to anonymous callers.
          // The second must not read like "this RPC needs a key", because to
          // a wallet user who found it on Chainlist it does not.
          const presented = req.headers["x-api-key"] || req.headers.authorization;
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: presented
              ? { code: -32001, message: "unauthorized: the x-api-key presented is not valid" }
              : {
                  code: -32601,
                  message: `${method} is not available without an API key on this endpoint (standard eth_/net_ reads and eth_sendRawTransaction are open); keys at https://app.ordofi.network/docs`,
                },
          };
        }

        // Anything answered from memory is free: no upstream, no limiter.
        // Only plain reads take this exit — the ordo_* methods and sends have
        // their own handling in dispatch.
        if (!method.startsWith("ordo_") && method !== "eth_sendRawTransaction") {
          const local = localAnswer(method, params);
          if (local !== undefined) return { jsonrpc: "2.0", id: msg.id, result: local };
        }

        // Keys are limited per key; anonymous callers per source IP (see
        // clientIp for what counts as the source behind Caddy and Cloudflare).
        // Anonymous sends have a second, stricter budget: each one costs a
        // simulation and a sequencer submission.
        const ip = clientIp(req);
        const rl =
          auth === "anon"
            ? limiter.check(`anon:${ip}`, CONFIG.anonRateLimit)
            : limiter.check(auth.key, auth.rateLimit);
        const sendRl =
          auth === "anon" && method === "eth_sendRawTransaction"
            ? sendLimiter.check(`anon-send:${ip}`, CONFIG.anonSendRateLimit)
            : { ok: true, retryAfterMs: 0 };
        if (!rl.ok || !sendRl.ok) {
          metrics.inc(sendRl.ok ? "rpc_rate_limited_total" : "rpc_send_rate_limited_total", {
            key: auth === "anon" ? "anon" : auth.label,
          });
          const retryAfterMs = Math.max(rl.retryAfterMs, sendRl.retryAfterMs);
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32005,
              message: `${sendRl.ok ? "rate" : "send rate"} limit exceeded, retry in ${Math.ceil(retryAfterMs / 1000)}s`,
            },
          };
        }

        // Concurrency, not just rate: an anonymous client may hold only so
        // many upstream requests at once, so one script cannot occupy the
        // upstream that every wallet here shares. Beyond the cap its requests
        // queue behind its own for up to two seconds, then are refused.
        const slot = auth === "anon" ? await inflight.acquire(`anon:${ip}`) : () => {};
        if (!slot) {
          metrics.inc("rpc_inflight_limited_total", { key: "anon" });
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32005,
              message: `too many concurrent requests from this address (${CONFIG.anonMaxInflight} in flight for over 2s); slow down`,
            },
          };
        }
        try {
          const result = await dispatch(
            method,
            params,
            auth === "anon"
              ? { key: "anon", label: "anon", rateLimit: 0, mode: CONFIG.anonAuction ? "auction" : "direct" }
              : auth,
          );
          return { jsonrpc: "2.0", id: msg.id, result };
        } catch (err) {
          const e = err as RpcError;
          metrics.inc("rpc_errors_total", { method });
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: e.code ?? -32000, message: e.message, data: e.data },
          };
        } finally {
          slot();
        }
      }),
    );

    metrics.observe("request_latency_ms", Date.now() - started);
    res.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
  });
});

/**
 * A rolling restart only works if the instance being replaced finishes what it
 * is doing. On SIGTERM: answer /health with 503 while still serving, long
 * enough for the edge's active check (every 2 s) to route around us — this
 * has to be comfortably more than one check interval, or the edge can write a
 * request onto a kept-alive connection in the same instant we close it, which
 * it cannot retry; then stop accepting, let in-flight requests (a protected
 * send is two upstream round trips) complete, and exit. A hard deadline covers
 * a wedged upstream. The whole sequence fits inside the compose
 * stop_grace_period.
 */
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  const grace = Number(process.env.ORDO_DRAIN_GRACE_MS ?? 5_000);
  const drain = Number(process.env.ORDO_DRAIN_MS ?? 10_000);
  console.log(`OrdoFi gateway | ${signal}: unhealthy for ${grace}ms, then draining`);
  setTimeout(() => {
    const deadline = setTimeout(() => {
      console.warn("OrdoFi gateway | drain deadline reached, exiting with requests in flight");
      process.exit(0);
    }, drain);
    deadline.unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  }, grace).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(CONFIG.port, () => {
  console.log(`OrdoFi gateway | listening on :${CONFIG.port} | upstream=${UPSTREAM}`);
  if (CONFIG.edgeOrigin) {
    console.log(
      `OrdoFi gateway | EDGE: chainId/net_version, the head, fees and mined receipts answered here; everything else forwarded verbatim to ${CONFIG.edgeOrigin} (keys, limits, protection, auction and ledger are the origin's)`,
    );
    return;
  }
  console.log(`OrdoFi gateway | ${apiKeys.size} api key(s) loaded | anon=${CONFIG.allowAnon}`);
  console.log(`OrdoFi gateway | GET /health /metrics /metrics.json`);
  console.log(
    `OrdoFi gateway | fast path: chainId/net_version local, head cached ${BLOCK_MS}ms, fees 1s, mined receipts 10m; hedged reads after ${CONFIG.hedgeAfterMs}ms across ${rpcUrls().length} upstream(s), at most ${Math.round(CONFIG.hedgeBudgetRatio * 100)}% of reads; anon ${CONFIG.anonRateLimit} upstream reads + ${CONFIG.anonSendRateLimit} sends /min/IP, ${CONFIG.anonMaxInflight} in flight/IP`,
  );
  console.log(
    `OrdoFi gateway | methods: eth_* passthrough, protected eth_sendRawTransaction, ordo_sendPrivateTransaction, ordo_simulate, ordo_sendBundle, ordo_bundlerInfo${CONFIG.ordoSwapAddress ? `, ordo_quoteSwap (OrdoSwap ${CONFIG.ordoSwapAddress})` : ""}`,
  );
  const auctionKeys = [...apiKeys.values()].filter((k) => k.mode === "auction");
  console.log(
    `OrdoFi gateway | order flow: ${auctionKeys.length}/${apiKeys.size} key(s) and ${
      CONFIG.anonAuction ? "anonymous sends" : "no anonymous sends"
    } routed to the auction at ${
      process.env.ORDO_AUCTION_URL ?? "http://localhost:8548"
    } (protected first either way; falls back to direct send if unreachable)`,
  );
  console.log(
    `OrdoFi gateway | atomic bundles=${
      process.env.ORDO_BUNDLER_ADDRESS
        ? `on (OrdoBundler ${process.env.ORDO_BUNDLER_ADDRESS})`
        : "off (no ORDO_BUNDLER_ADDRESS) — multi-tx bundles stay best-effort"
    }`,
  );
});
