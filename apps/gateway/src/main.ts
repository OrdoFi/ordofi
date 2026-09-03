import { createServer } from "node:http";
import { landingHtml } from "./landing.ts";
import { join } from "node:path";
import { ENDPOINTS, rpcFetch, rpcOnce, rpcUrls, sendRawTransaction, sequencerUrl } from "@ordofi/core";
import { OrdoStore } from "@ordofi/store";
import { CONFIG, loadApiKeys, RateLimiter, type ApiKey } from "./config.js";
import { RpcError } from "./errors.js";
import { Metrics } from "./metrics.js";
import { bundlerInfo, protectAndSend, sendBundle, simulateRaw } from "./protect.js";
import { routeOrderFlow } from "./orderflow.js";
import { BLOCK_MS, IDEMPOTENT_READS, MicroCache, cacheKey, cacheTtlMs, clientIp, hedged, staticAnswer } from "./fastpath.js";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { callOrigin, forwardHeaders, type OriginReply } from "./edge.js";

const UPSTREAM = ENDPOINTS.rpc;
const apiKeys = loadApiKeys();
const limiter = new RateLimiter();
const sendLimiter = new RateLimiter();
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
  return hedged(
    () => rpcFetch(method, params),
    () => rpcOnce(urls[1], method, params),
    CONFIG.hedgeAfterMs,
    (ev) => metrics.inc(ev === "fired" ? "hedge_fired_total" : "hedge_won_total"),
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
    const code = (e as { code?: number }).code;
    if (typeof code === "number") throw new RpcError(code, (e as Error).message);
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

  if (header && apiKeys.has(header)) return apiKeys.get(header)!;
  if (header) {
    const fromStore = storeBackedKey(header);
    if (fromStore) return fromStore;
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

let stopping = false;

const server = createServer((req, res) => {
  const url = req.url ?? "/";

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
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "unauthorized: valid x-api-key required" },
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

        try {
          const result = await dispatch(
            method,
            params,
            auth === "anon" ? { key: "anon", label: "anon", rateLimit: 0, mode: "direct" } : auth,
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
    `OrdoFi gateway | fast path: chainId/net_version local, head cached ${BLOCK_MS}ms, fees 1s, mined receipts 10m; hedged reads after ${CONFIG.hedgeAfterMs}ms across ${rpcUrls().length} upstream(s); anon ${CONFIG.anonRateLimit} upstream reads + ${CONFIG.anonSendRateLimit} sends /min/IP`,
  );
  console.log(
    `OrdoFi gateway | methods: eth_* passthrough, protected eth_sendRawTransaction, ordo_sendPrivateTransaction, ordo_simulate, ordo_sendBundle, ordo_bundlerInfo`,
  );
  const auctionKeys = [...apiKeys.values()].filter((k) => k.mode === "auction");
  console.log(
    `OrdoFi gateway | order flow: ${auctionKeys.length}/${apiKeys.size} key(s) routed to the auction at ${
      process.env.ORDO_AUCTION_URL ?? "http://localhost:8548"
    } (falls back to direct send if unreachable)`,
  );
  console.log(
    `OrdoFi gateway | atomic bundles=${
      process.env.ORDO_BUNDLER_ADDRESS
        ? `on (OrdoBundler ${process.env.ORDO_BUNDLER_ADDRESS})`
        : "off (no ORDO_BUNDLER_ADDRESS) — multi-tx bundles stay best-effort"
    }`,
  );
});
