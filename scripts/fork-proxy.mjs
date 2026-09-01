/**
 * A local JSON-RPC proxy in front of Robinhood Chain's public endpoint.
 *
 * Two problems it solves, both of which are really the same problem — the
 * public endpoint is not built to be leaned on:
 *
 *   1. Cloudflare serves Foundry a bot challenge. `cast` gets through and
 *      `forge --fork-url` does not, purely on user agent, so fork tests against
 *      real mainnet state fail before they start. This proxy presents an
 *      ordinary browser user agent and forwards the body untouched.
 *
 *   2. The endpoint rate limits hard (HTTP 429). Requests are queued at a fixed
 *      concurrency with backoff, and immutable results — code, receipts, and
 *      historical blocks — are cached in memory, which is most of what a fork
 *      backend asks for repeatedly.
 *
 * This is a development crutch. The real fix is the archive node in
 * `deploy/nitro-node/`; until that is running, this is what makes
 * `forge test --fork-url http://127.0.0.1:8545` work at all.
 *
 *   node scripts/fork-proxy.mjs
 *   forge test --fork-url http://127.0.0.1:8545
 */
import { createServer } from "node:http";

const UPSTREAM = process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const PORT = Number(process.env.ORDO_PROXY_PORT ?? 8545);
const CONCURRENCY = Number(process.env.ORDO_PROXY_CONCURRENCY ?? 4);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Methods whose answer for a given argument can never change. */
const IMMUTABLE = new Set([
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_chainId",
  "net_version",
]);

const cache = new Map();
const stats = { requests: 0, cached: 0, upstream: 0, retried: 0, failed: 0 };

let inFlight = 0;
const queue = [];

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (inFlight < CONCURRENCY && queue.length) {
    const { task, resolve, reject } = queue.shift();
    inFlight++;
    task()
      .then(resolve, reject)
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forward(payload) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": UA,
        origin: "https://robinhoodchain.blockscout.com",
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (res.status === 429 || res.status === 403 || text.startsWith("<")) {
      stats.retried++;
      await sleep(Math.min(250 * 2 ** attempt, 4000));
      continue;
    }
    return JSON.parse(text);
  }
  stats.failed++;
  throw new Error("upstream refused after 8 attempts");
}

/** Cache key for a single request, or null when the result is not immutable. */
function keyOf(req) {
  if (!IMMUTABLE.has(req.method)) return null;
  // A code or balance read pinned to "latest" is not immutable.
  if (req.params?.some?.((p) => p === "latest" || p === "pending")) return null;
  return `${req.method}:${JSON.stringify(req.params ?? [])}`;
}

async function handleOne(req) {
  stats.requests++;
  const key = keyOf(req);
  if (key && cache.has(key)) {
    stats.cached++;
    return { ...cache.get(key), id: req.id };
  }

  stats.upstream++;
  const out = await schedule(() => forward(req));
  if (key && out?.result !== undefined && !out.error) cache.set(key, out);
  return out;
}

const server = createServer((httpReq, httpRes) => {
  if (httpReq.method === "GET") {
    httpRes.writeHead(200, { "content-type": "application/json" });
    httpRes.end(JSON.stringify({ upstream: UPSTREAM, cacheEntries: cache.size, ...stats }, null, 2));
    return;
  }

  let body = "";
  httpReq.on("data", (c) => (body += c));
  httpReq.on("end", async () => {
    httpRes.setHeader("content-type", "application/json");
    try {
      const payload = JSON.parse(body);
      // Batches arrive as arrays and must come back in the same order.
      const out = Array.isArray(payload)
        ? await Promise.all(payload.map(handleOne))
        : await handleOne(payload);
      httpRes.end(JSON.stringify(out));
    } catch (err) {
      httpRes.writeHead(502);
      httpRes.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(err) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ordo fork-proxy | 127.0.0.1:${PORT} -> ${UPSTREAM}`);
  console.log(`ordo fork-proxy | concurrency=${CONCURRENCY}, immutable results cached`);
  console.log(`ordo fork-proxy | forge test --fork-url http://127.0.0.1:${PORT}`);
});

setInterval(() => {
  if (stats.requests) {
    process.stdout.write(
      `\rrequests=${stats.requests} cached=${stats.cached} upstream=${stats.upstream} retried=${stats.retried} failed=${stats.failed}   `,
    );
  }
}, 2000).unref();
