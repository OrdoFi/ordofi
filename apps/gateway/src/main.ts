import { createServer } from "node:http";
import { landingHtml } from "./landing.ts";
import { join } from "node:path";
import { ENDPOINTS, rpcFetch, sendRawTransaction, sequencerUrl } from "@ordofi/core";
import { OrdoStore } from "@ordofi/store";
import { CONFIG, loadApiKeys, RateLimiter, type ApiKey } from "./config.js";
import { RpcError } from "./errors.js";
import { Metrics } from "./metrics.js";
import { bundlerInfo, protectAndSend, sendBundle, simulateRaw } from "./protect.js";
import { routeOrderFlow } from "./orderflow.js";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";

const UPSTREAM = ENDPOINTS.rpc;
const apiKeys = loadApiKeys();
const limiter = new RateLimiter();

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
    // rpcFetch rotates across ORDO_RPC_URLS on transport failures (403
    // challenge pages, timeouts) and rethrows genuine JSON-RPC errors with
    // their code — those come from a healthy upstream and must not rotate.
    return await rpcFetch(method, params);
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

function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

const LANDING = landingHtml({
  chainId: 4663,
  explorer: "https://robinhoodchain.blockscout.com",
  docs: "https://app.ordofi.network/docs",
  portal: "https://app.ordofi.network/portal",
  app: "https://app.ordofi.network",
});

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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstream: UPSTREAM, sequencer: sequencerUrl(), uptimeSeconds: metrics.json().uptimeSeconds }));
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

        const auth = authenticate({ headers: req.headers }, method);
        if (!auth) {
          metrics.inc("rpc_unauthorized_total", { method });
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "unauthorized: valid x-api-key required" },
          };
        }

        // Keys are limited per key; anonymous callers per source IP (the
        // first x-forwarded-for hop is the client when Caddy fronts us).
        const rl =
          auth === "anon"
            ? limiter.check(`anon:${clientIp(req)}`, CONFIG.anonRateLimit)
            : limiter.check(auth.key, auth.rateLimit);
        if (!rl.ok) {
          metrics.inc("rpc_rate_limited_total", { key: auth === "anon" ? "anon" : auth.label });
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32005,
              message: `rate limit exceeded, retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
            },
          };
        }

        try {
          const result = await dispatch(
            method,
            msg.params ?? [],
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

server.listen(CONFIG.port, () => {
  console.log(`OrdoFi gateway | listening on :${CONFIG.port} | upstream=${UPSTREAM}`);
  console.log(`OrdoFi gateway | ${apiKeys.size} api key(s) loaded | anon=${CONFIG.allowAnon}`);
  console.log(`OrdoFi gateway | GET /health /metrics /metrics.json`);
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
