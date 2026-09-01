import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createPublicClient, fallback, http, parseAbiItem, formatEther, encodeFunctionData, decodeFunctionResult, decodeEventLog, toEventSelector } from "viem";
import { RPC_HEADERS, rpcUrls, rpcFetch } from "@ordofi/core";
import { ethUsd } from "@ordofi/core/pricing";
import { OrdoStore } from "@ordofi/store";
import { gzipSync } from "node:zlib";
import { tradeTokens, tradeQuote, tradeCandles, CHAIN as TRADE_CHAIN, tradePair, tradeTrades, tradeBalances, tradeMarkets, tradeToken, resolverStats, warmTradeCaches } from "./trade.mjs";

/** JSON reply, gzipped when the client accepts it — the token list is large. */
function sendJson(req, res, status, body, headers = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const gz = raw.length > 2048 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  res.writeHead(status, {
    "content-type": "application/json",
    ...(gz ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
    ...headers,
  });
  res.end(gz ? gzipSync(raw) : raw);
}

/**
 * The index is the query path. NDJSON is kept as the raw record and used as a
 * fallback so the Explorer still renders on a machine that has files but no
 * database yet (or a database that hasn't been written to).
 */
const DB_FILE = process.env.ORDO_DB ?? join(import.meta.dirname, "../../data/ordo.db");
let store = null;
try {
  store = new OrdoStore(DB_FILE);
} catch (e) {
  console.warn(`web | index unavailable (${e.message}); falling back to NDJSON`);
}

const ROOT = join(import.meta.dirname, "public");
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../data");
const PORT = Number(process.env.ORDO_WEB_PORT ?? 3000);
const RPC = process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS ?? "";

/** Report from the index when it has data, else the generated report.json. */
function loadReport() {
  const indexed = indexedReport();
  if (indexed) return indexed;
  const f = join(DATA_DIR, "report.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function recentArbs(n) {
  // Prefer the index; fall back to the raw NDJSON tail.
  if (store) {
    try {
      const rows = store.recentArbs(n);
      if (rows.length > 0) {
        return rows.map((r) => ({
          block: r.block,
          timestamp: r.timestamp,
          txHash: r.txHash,
          sender: r.sender,
          poolsTouched: r.pools,
          profitToken: r.profitToken,
          profitWei: r.profitWei,
          profitIsQuote: r.profitIsQuote,
        }));
      }
    } catch {
      /* fall through to files */
    }
  }
  const f = join(DATA_DIR, "arbs.ndjson");
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-n)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Shortest sample a daily rate may be extrapolated from. Below this the
 * multiplier is large enough to turn a normal burst of activity into a number
 * nobody would believe: a few seconds of blocks once implied 769,745 arbs a
 * day, which is nine a second.
 */
const MIN_EXTRAPOLATION_HOURS = 1;

export function perDayArbs(arbs, spanHours) {
  if (!(spanHours >= MIN_EXTRAPOLATION_HOURS)) return null;
  return (arbs / spanHours) * 24;
}

/** Headline figures straight from the index, when it has data. */
function indexedReport() {
  if (!store) return null;
  try {
    const totals = store.totals();
    if (totals.arbs === 0) return null;
    const w = store.window();
    return {
      window: w,
      totals: {
        arbs: totals.arbs,
        uniqueSearchers: totals.searchers,
        uniquePools: totals.pools,
        swaps: store.swapCount(),
      },
      perDay: { arbs: perDayArbs(totals.arbs, w.spanHours) },
      topSearchers: store.topSearchers(10).map((s) => [s.address, s.count]),
      topPools: store.topPools(10).map((p) => [p.pool, p.count]),
      source: "index",
    };
  } catch {
    return null;
  }
}

async function auctionStats() {
  const url = process.env.ORDO_AUCTION_URL ?? "http://localhost:8548";
  try {
    const r = await fetch(`${url}/stats`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * The house arb desk. The bot serves its own status; we proxy it so the page
 * can show live scans, and fall back to the fill ledger on the shared volume
 * when the bot is down so the money history never disappears from the page.
 */
const ARB_URL = process.env.ORDO_ARB_URL ?? "http://localhost:8549";
let deskCache = null;

function deskFromLedger() {
  const f = join(DATA_DIR, "arb-ledger.ndjson");
  const events = [];
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* torn tail */ }
    }
  }
  let fires = 0, won = 0, reverted = 0, gasWei = 0n, grossWei = 0n, gas24h = 0n;
  const cutoff = Date.now() - 86_400_000;
  for (const e of events) {
    if (e.kind === "fire") fires++;
    if (e.kind === "won") { won++; gasWei += BigInt(e.gasWei); grossWei += BigInt(e.returnedWei) - BigInt(e.sizeWei); if (e.t > cutoff) gas24h += BigInt(e.gasWei); }
    if (e.kind === "reverted") { reverted++; gasWei += BigInt(e.gasWei); if (e.t > cutoff) gas24h += BigInt(e.gasWei); }
  }
  return {
    ok: true,
    live: false,
    now: Date.now(),
    totals: {
      fires, won, reverted,
      gasEth: formatEther(gasWei), grossEth: formatEther(grossWei), netEth: formatEther(grossWei - gasWei),
      gas24hEth: formatEther(gas24h), dailyGasCapEth: null, breaker: false,
    },
    events: events.slice(-80).reverse(),
    scans: { count: 0, quotesTotal: 0, lastAt: null, last: null, history: [] },
  };
}

async function deskStatus() {
  if (deskCache && Date.now() - deskCache.at < 2000) return deskCache.data;
  let data;
  try {
    const r = await fetch(`${ARB_URL}/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error(`arb ${r.status}`);
    data = await r.json();
  } catch {
    data = deskFromLedger();
  }
  data.ethUsd = await ethUsd().catch(() => null);
  deskCache = { at: Date.now(), data };
  return data;
}

const SETTLED_EVENT = parseAbiItem(
  "event Settled(bytes32 indexed opportunityId, address indexed searcher, uint256 amount, uint256 userAmt, uint256 appAmt, uint256 protocolAmt, address user, address app)",
);
const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed searcher, uint256 amount, uint256 newBond)",
);
const CLAIMED_EVENT = parseAbiItem("event Claimed(address indexed beneficiary, uint256 amount)");

const fallbackTransport = () =>
  fallback(rpcUrls().map((u) => http(u, { fetchOptions: { headers: RPC_HEADERS } })));

let lastOnchain = null; // { data, at } — survives upstream challenges

async function onchainStats(address) {
  if (!address) return { deployed: false, note: "ORDO_SETTLEMENT_ADDRESS not set" };
  try {
    const data = await onchainStatsFresh(address);
    lastOnchain = { data, at: Date.now() };
    return data;
  } catch (e) {
    // The public RPC intermittently refuses our log scans (rate limit / bot
    // challenge). Serving the last good snapshot, marked stale, is honest;
    // reporting a deployed contract as "deployed: false" is not.
    if (lastOnchain) {
      return { ...lastOnchain.data, stale: true, asOf: new Date(lastOnchain.at).toISOString() };
    }
    throw e;
  }
}

/**
 * Settlements read straight from the contract's own logs.
 *
 * The index is the fast path, but it is a local cache: rebuilding it, as a
 * corrected attribution rule required, silently took the record of a real
 * mainnet settlement with it and the site went back to reporting zero. What
 * the chain emitted cannot be lost that way, so it is the authority whenever
 * the index has nothing to say.
 *
 * Scanned in chunks from the deployment block, because one range that wide is
 * exactly what the public endpoints refuse.
 */
const DEPLOY_BLOCK = BigInt(process.env.ORDO_SETTLEMENT_BLOCK ?? 51544378);
const LOG_CHUNK = 50_000n;
let settledLogsCache = null;

async function settledLogs(address) {
  if (settledLogsCache && Date.now() - settledLogsCache.at < 120_000) return settledLogsCache.logs;

  const head = BigInt(await rpcFetch("eth_blockNumber", []));
  const topic = toEventSelector(SETTLED_EVENT);
  const out = [];
  for (let from = DEPLOY_BLOCK; from <= head; from += LOG_CHUNK) {
    const upper = from + LOG_CHUNK - 1n;
    const to = upper > head ? head : upper;
    const logs = await rpcFetch("eth_getLogs", [
      {
        address,
        topics: [topic],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      },
    ]);
    for (const l of logs ?? []) {
      const decoded = decodeEventLog({ abi: [SETTLED_EVENT], data: l.data, topics: l.topics });
      out.push({ ...decoded, txHash: l.transactionHash, block: Number(BigInt(l.blockNumber)) });
    }
  }
  settledLogsCache = { at: Date.now(), logs: out };
  return out;
}

async function onchainStatsFresh(address) {
  // One cheap call decides "deployed"; the old way was three half-million
  // block log scans, which the public endpoints either 403 or ration.
  // viem's fallback treats a 403 as deterministic and gives up; rpcFetch
  // rotates — and the 403 challenge page is exactly what we route around.
  const code = await rpcFetch("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") return { deployed: false, address };

  // Exact figures come from the index the auction writes at settlement time.
  // The split is computed from configuration, which is honest as long as it
  // is labelled: the contract enforces the split, we display it.
  let totals = store?.settlementTotals?.() ?? { settlements: 0, totalChargeWei: 0n };
  let source = "index";
  let chainRecent = null;

  if (totals.settlements === 0) {
    try {
      const logs = await settledLogs(address);
      if (logs.length > 0) {
        totals = {
          settlements: logs.length,
          totalChargeWei: logs.reduce((n, l) => n + l.args.amount, 0n),
        };
        source = "chain";
        chainRecent = logs.slice(-15).reverse();
      }
    } catch {
      // A failed scan is not evidence of zero; leave the index's answer alone.
    }
  }
  const user = Number(process.env.ORDO_REBATE_USER ?? 0.9);
  const app = Number(process.env.ORDO_REBATE_APP ?? 0.05);
  const charge = totals.totalChargeWei;
  const share = (f) => formatEther((charge * BigInt(Math.round(f * 1e6))) / 1_000_000n);

  const recent =
    chainRecent?.map((l) => ({
      opportunityId: l.args.opportunityId,
      searcher: l.args.searcher,
      amountEth: formatEther(l.args.amount),
      userEth: formatEther(l.args.userAmt),
      app: l.args.app,
      txHash: l.txHash,
      block: l.block,
    })) ??
    (store?.recentSettlements(15) ?? []).map((r) => ({
      opportunityId: r.opportunityId,
      searcher: r.searcher,
      amountEth: formatEther(BigInt(r.chargeWei)),
      userEth: formatEther((BigInt(r.chargeWei) * BigInt(Math.round(user * 1e6))) / 1_000_000n),
      app: r.appAddress,
      txHash: r.txHash ?? null,
      block: null,
    }));

  return {
    deployed: true,
    address,
    rpc: RPC,
    totalsSource: source,
    totals: {
      settlements: totals.settlements,
      totalSettledEth: formatEther(charge),
      rebatesToUsersEth: share(user),
      rebatesToAppsEth: share(app),
      protocolFeesEth: share(Math.max(0, 1 - user - app)),
      totalBondedEth: null,
      totalClaimedEth: null,
    },
    recent,
  };
}

const VIEW_ABI = [
  { type: "function", name: "bond", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

async function accountView(address) {
  const read = async (functionName) => {
    const data = encodeFunctionData({ abi: VIEW_ABI, functionName, args: [address] });
    const out = await rpcFetch("eth_call", [{ to: SETTLEMENT, data }, "latest"]);
    return decodeFunctionResult({ abi: VIEW_ABI, functionName, data: out });
  };
  const [bond, claimable] = SETTLEMENT ? await Promise.all([read("bond"), read("claimable")]) : [0n, 0n];

  const a = address.toLowerCase();
  let asSearcher = [];
  let asApp = [];
  try {
    asSearcher = store?.recentSettlements(200).filter((s) => s.searcher.toLowerCase() === a).slice(0, 20) ?? [];
    asApp = store?.recentSettlements(200).filter((s) => s.appAddress.toLowerCase() === a).slice(0, 20) ?? [];
  } catch {
    /* index optional */
  }

  return {
    address,
    settlement: SETTLEMENT || null,
    bondEth: formatEther(bond),
    claimableEth: formatEther(claimable),
    settlementsAsSearcher: asSearcher,
    settlementsAsApp: asApp,
    claimHint: `cast send ${SETTLEMENT} "claim()" --rpc-url ${RPC} --account <your-keystore>`,
  };
}

/** Fixed-window issuance limiter: three keys per hour per IP. */
const issuance = new Map();
function issueAllowed(ip) {
  const now = Date.now();
  const w = issuance.get(ip);
  if (!w || now >= w.resetAt) {
    issuance.set(ip, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (w.count >= 3) return false;
  w.count++;
  return true;
}

async function handle(req, res) {
  let path = (req.url ?? "/").split("?")[0];
  const url = new URL(req.url ?? "/", "http://x");

  // Public API: CORS-open so external sites (e.g. the Framer marketing site)
  // can embed live OrdoFi numbers directly.
  if (path.startsWith("/api/")) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("cache-control", "public, max-age=15");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
  }

  // Compact, embed-friendly stats for the marketing site.
  if (path === "/api/stats") {
    const rep = loadReport();
    let onchain = { deployed: false };
    try {
      onchain = await onchainStats(SETTLEMENT);
    } catch {
      /* ignore */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        chain: { name: "Robinhood Chain", chainId: 4663 },
        arbs: rep?.totals?.arbs ?? 0,
        searchers: rep?.totals?.uniqueSearchers ?? 0,
        pools: rep?.totals?.uniquePools ?? 0,
        swaps: rep?.totals?.swaps ?? 0,
        // null until the sample is long enough to extrapolate honestly.
        arbsPerDay: rep?.perDay?.arbs == null ? null : Math.round(rep.perDay.arbs),
        settlement: onchain.deployed
          ? {
              deployed: true,
              address: onchain.address,
              settlements: onchain.totals.settlements,
              totalSettledEth: onchain.totals.totalSettledEth,
              rebatesToUsersEth: onchain.totals.rebatesToUsersEth,
              totalBondedEth: onchain.totals.totalBondedEth,
            }
          : { deployed: false },
        updatedAt: new Date().toISOString(),
      }),
    );
    return;
  }

  // Self-serve credential issuance. The key is returned exactly once and only
  // its hash is stored, so there is nothing here worth stealing later. Per-IP
  // limiting keeps a bored script from minting thousands of rows.
  if (path === "/api/keys" && req.method === "POST") {
    if (!store) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "key store unavailable on this host" }));
      return;
    }
    const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").toString().split(",")[0];
    if (!issueAllowed(ip)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "limit reached — three keys per hour per address" }));
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2048) break;
    }
    try {
      const { label, rebateAddress } = JSON.parse(body || "{}");
      if (rebateAddress && !/^0x[0-9a-fA-F]{40}$/.test(rebateAddress)) {
        throw new Error("rebateAddress must be a 20-byte 0x address");
      }
      const issued = store.issueApiKey({ label, rebateAddress });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          key: issued.key,
          label: issued.record.label,
          mode: issued.record.mode,
          rebateAddress: issued.record.rebateAddress ?? null,
          rateLimitPerMin: issued.record.rateLimit,
          note: "Store this now — it is shown once and only a hash is kept.",
          rpc: "https://rpc.ordofi.network (header: x-api-key)",
        }),
      );
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Everything the portal shows for one address: live bond and claimable
  // straight from the contract, plus its settlement history from the index.
  if (path === "/api/account") {
    const address = url.searchParams.get("address") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "pass ?address=0x…" }));
      return;
    }
    try {
      const view = await accountView(address);
      sendJson(req, res, 200, view);
    } catch (e) {
      sendJson(req, res, 502, { error: e.message });
    }
    return;
  }

  // ---- Trade terminal ----------------------------------------------------

  // Wallet-facing chain config, so "add the protected RPC" is one click.
  if (path === "/api/trade/chain") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(TRADE_CHAIN));
    return;
  }

  if (path === "/api/trade/tokens") {
    try {
      sendJson(req, res, 200, await tradeTokens(store));
    } catch (e) {
      sendJson(req, res, 502, { error: e.message });
    }
    return;
  }

  if (path === "/api/trade/markets") {
    try {
      sendJson(req, res, 200, await tradeMarkets(store), { "cache-control": "public, max-age=15" });
    } catch (e) {
      sendJson(req, res, 502, { error: e.message });
    }
    return;
  }

  if (path === "/api/trade/token") {
    try {
      sendJson(req, res, 200, await tradeToken(store, url.searchParams.get("address") ?? ""), { "cache-control": "no-store" });
    } catch (e) {
      sendJson(req, res, 400, { error: e.message }, { "cache-control": "no-store" });
    }
    return;
  }

  if (path === "/api/trade/resolvers") {
    sendJson(req, res, 200, resolverStats(), { "cache-control": "no-store" });
    return;
  }

  if (path === "/api/trade/quote") {
    try {
      const q = await tradeQuote({
        tokenIn: (url.searchParams.get("tokenIn") ?? "").toLowerCase(),
        tokenOut: (url.searchParams.get("tokenOut") ?? "").toLowerCase(),
        amountIn: url.searchParams.get("amountIn") ?? "0",
        slippageBps: Math.min(3000, Math.max(1, Number(url.searchParams.get("slippageBps") ?? 50))),
        from: url.searchParams.get("from"),
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(q));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (path === "/api/trade/candles") {
    try {
      const data = await tradeCandles({
        base: (url.searchParams.get("base") ?? "").toLowerCase(),
        quote: (url.searchParams.get("quote") ?? "").toLowerCase(),
        bucketSec: Math.max(60, Math.min(86_400, Number(url.searchParams.get("bucketSec") ?? 60))),
        spanBlocks: Math.max(6000, Math.min(200_000, Number(url.searchParams.get("spanBlocks") ?? 72_000))),
        hours: url.searchParams.has("hours") ? Math.max(1, Math.min(24 * 400, Number(url.searchParams.get("hours")))) : null,
        store,
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=30" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (path === "/api/trade/pair") {
    try {
      const data = await tradePair({
        base: (url.searchParams.get("base") ?? "").toLowerCase(),
        quote: (url.searchParams.get("quote") ?? "").toLowerCase(),
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=30" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (path === "/api/trade/trades") {
    try {
      const data = await tradeTrades({
        base: (url.searchParams.get("base") ?? "").toLowerCase(),
        quote: (url.searchParams.get("quote") ?? "").toLowerCase(),
        limit: Math.max(5, Math.min(100, Number(url.searchParams.get("limit") ?? 40))),
        store,
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (path === "/api/trade/balances") {
    try {
      const data = await tradeBalances(store, url.searchParams.get("address") ?? "");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (path === "/api/report") {
    const rep = loadReport();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rep ?? { error: "no data yet — run the watcher" }));
    return;
  }

  if (path === "/api/onchain") {
    let body;
    try {
      body = await onchainStats(url.searchParams.get("address") || SETTLEMENT);
    } catch (e) {
      body = { deployed: false, error: e.message };
    }
    sendJson(req, res, 200, body);
    return;
  }

  if (path === "/api/arbs/recent") {
    const n = Math.min(200, Number(url.searchParams.get("n") ?? 40));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(recentArbs(n)));
    return;
  }

  if (path === "/api/auction") {
    sendJson(req, res, 200, await auctionStats().catch(() => null));
    return;
  }

  if (path === "/api/desk") {
    let body;
    try {
      body = await deskStatus();
    } catch (e) {
      body = { ok: false, live: false, error: e.message };
    }
    sendJson(req, res, 200, body, { "cache-control": "public, max-age=2" });
    return;
  }

  if (path === "/api/explorer") {
    res.writeHead(200, { "content-type": "application/json" });
    const report = loadReport();
    let onchain = { deployed: false };
    try {
      onchain = await onchainStats(SETTLEMENT);
    } catch {
      /* ignore */
    }
    res.end(
      JSON.stringify({
        report,
        recentArbs: recentArbs(40),
        auction: await auctionStats(),
        onchain,
        generatedAt: new Date().toISOString(),
      }),
    );
    return;
  }

  if (path === "/") path = "/index.html";
  if (path === "/favicon.ico") path = "/favicon-32.png";
  if (path === "/portal") path = "/portal.html";
  if (path === "/trade") path = "/trade.html";
  if (path === "/desk") path = "/desk.html";
  if (path === "/docs") path = "/docs.html";
  if (path === "/dashboard") path = "/dashboard.html";
  if (path === "/explorer") path = "/explorer.html";
  if (path === "/searchers") path = "/searchers.html";
  if (path === "/apps") path = "/apps.html";
  if (path === "/operators") path = "/operators.html";
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`web | ${req.method} ${req.url}: ${e?.stack ?? e}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal error" }));
  });
}).listen(PORT, () => console.log(`OrdoFi web | http://localhost:${PORT}  (dashboard at /dashboard)`));

// A background refresh that rejects must never become a process exit.
process.on("unhandledRejection", (e) => console.error(`web | unhandled rejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e) => console.error(`web | uncaught exception: ${e?.stack ?? e}`));

// Warm the trade caches at boot: pool composition for today's busiest pools
// and the token list. Building them takes dozens of round-trips, and the first
// page load should never be the one paying for that.
warmTradeCaches(store)
  .then((list) => console.log(`web | trade: ${list.length} tokens listed; resolvers ${JSON.stringify(resolverStats())}`))
  .catch((e) => console.warn(`web | trade warm-up failed: ${e.message}`));
