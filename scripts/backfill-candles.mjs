#!/usr/bin/env node
/**
 * Backfill the chart tape from chain history.
 *
 * The watcher records candles from the moment it starts; everything before
 * that has to be read back out of the pools' Swap events. That needs an
 * upstream with full log history. Our own Nitro node has it with no limits;
 * until it is synced, the only free endpoint that serves history is the
 * sequencer operator's own RPC, which caps a query at 10,000 logs, times out
 * on wide windows, and throttles hard — so this script paces itself, backs
 * off on 429s, and shrinks its window when a query is refused.
 *
 *   node scripts/backfill-candles.mjs --rpc http://node:8547[,https://…] [--days 90 | --all] [--pools 500] [--pool 0x…]
 *                                     [--pace 400] [--parallel 8]
 *
 * Walks each pool backwards from the recorder's earliest bucket (or the head)
 * in adaptive block windows, converts every V3 Swap into a minute candle, and
 * upserts into the same table the watcher writes. Progress is checkpointed
 * per pool in the meta table, so it can be stopped and resumed, and a second
 * run against a better upstream simply continues where the first left off.
 * Block times come from headers at window edges, interpolated inside the
 * window; at 0.1 s blocks that is accurate to well under a minute.
 */
import { OrdoStore } from "@ordofi/store";
import { join } from "node:path";
import { toEventSelector } from "viem";

const args = {};
for (let k = 2; k < process.argv.length; k++) {
  if (!process.argv[k].startsWith("--")) continue;
  const next = process.argv[k + 1];
  // --max-logs reads as args.maxLogs, so a dashed flag is not silently ignored.
  const name = process.argv[k].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (next !== undefined && !next.startsWith("--")) { args[name] = next; k++; }
  else args[name] = "1";
}
const RPCS = (args.rpc ?? process.env.ORDO_ARCHIVE_RPC ?? "").split(",").map((u) => u.trim()).filter(Boolean);
if (RPCS.length === 0) {
  console.error("need --rpc <url with full eth_getLogs history> (or ORDO_ARCHIVE_RPC)");
  process.exit(2);
}
const ALL = args.all === "1";
const DAYS = Number(args.days ?? 90);
const MAX_POOLS = Number(args.pools ?? 500);
const PACE_MS = Number(args.pace ?? 600);
// How many log windows to keep in flight. One is right for the throttled public
// endpoint; raise it to match an archive plan's requests-per-second headroom.
const PARALLEL = Math.max(1, Number(args.parallel ?? 1));
// Providers cap eth_getLogs differently: Robinhood's endpoint by log count,
// Chainstack's by block range. Rather than hard-code either, remember the
// narrowest span that was ever refused and never grow back into it.
let spanCeiling = Number(args.maxSpan ?? 200_000);
// Target logs per window. Every window in a round is parsed at once, so this
// times --parallel is the memory the job will ask for.
const MAX_LOGS = Number(args.maxLogs ?? 12_000);
const DB = process.env.ORDO_DB ?? join(import.meta.dirname, "../data/ordo.db");
const V3_SWAP_TOPIC = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
// Uniswap V4: every pool's swaps are one event stream on the singleton, keyed by
// PoolId in the first topic. The data words line up with V3's (amount0, amount1,
// sqrtPriceX96, …), so the same parser reads both.
const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const V4_SWAP_TOPIC = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
// --v4 all   walk the singleton too and keep every pool's swaps (default when any V4 pool is listed)
// --v4 only  walk the singleton alone (V3 pools already have their history)
// --v4 none  V3 only
const V4_MODE = args.v4 ?? "auto";
const BLOCKS_PER_DAY = 864_000; // 0.1 s blocks

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RPC_HEADERS = { "content-type": "application/json", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) ordofi-backfill" };

/** Throttled or challenged: wait and try again (rotating upstreams). */
function isThrottle(e) {
  return e.status === 429 || e.code === 429 || e.status === 403 || e.status >= 500 || e.nonJson || /too many|rate limit|challenge/i.test(e.message);
}
/** The window is too wide for this upstream: caller should shrink it. */
function isTooWide(e) {
  return /exceeds limit|timed out|too many results|query returned more than|response size|block range|limit of/i.test(e.message);
}

let rpcId = 0, cursor = 0, lastCallAt = 0, throttles = 0, calls = 0;
async function rpcOnce(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: RPC_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { throw Object.assign(new Error(`HTTP ${r.status}: ${text.slice(0, 80)}`), { status: r.status, nonJson: true }); }
  if (body.error) throw Object.assign(new Error(body.error.message ?? "rpc error"), { code: body.error.code, status: r.status });
  return body.result;
}

/**
 * Paced, retrying call. Throttles back off exponentially (2 s … 60 s) and
 * rotate to the next upstream; anything else — including "too wide" — is
 * thrown to the caller, which knows whether to shrink the window.
 */
async function rpc(method, params) {
  let wait = 2_000;
  for (let attempt = 0; ; attempt++) {
    const gap = PACE_MS - (Date.now() - lastCallAt);
    if (gap > 0) await sleep(gap);
    lastCallAt = Date.now();
    const url = RPCS[cursor % RPCS.length];
    try {
      calls++;
      return await rpcOnce(url, method, params);
    } catch (e) {
      if (!isThrottle(e) || attempt >= 12) throw e;
      throttles++;
      cursor++;
      if (RPCS.length === 1 || attempt % RPCS.length === RPCS.length - 1) {
        if (wait >= 16_000) console.log(`backfill | throttled (${e.status ?? e.code ?? "?"}), waiting ${wait / 1000}s · ${throttles} throttles / ${calls} calls so far`);
        await sleep(wait);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }
}

const store = new OrdoStore(DB);
const head = parseInt(await rpc("eth_blockNumber", []), 16);
const floorBlock = ALL ? 0 : Math.max(0, head - DAYS * BLOCKS_PER_DAY);
console.log(`backfill | rpc=${RPCS.map((u) => new URL(u).host).join(",")} head=${head} floor=${floorBlock} (${ALL ? "all history" : DAYS + "d"}) pace=${PACE_MS}ms parallel=${PARALLEL} db=${DB}`);

// Which pools: the busiest by recorded swaps, plus anything explicitly named.
// A 20-byte address is a V3 pool; a 32-byte PoolId is a V4 pool and means the
// singleton gets walked (every V4 pool's swaps come along; none is dearer than the rest).
let listed = [];
if (args.pool) listed = args.pool.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
else {
  const since = Math.floor(Date.now() / 1000) - 7 * 86_400;
  listed = store.marketStats(since).map((r) => r.pool.toLowerCase());
}
const v4Listed = listed.filter((p) => p.length === 66);
const pools = V4_MODE === "only" ? [] : listed.filter((p) => p.length === 42).slice(0, MAX_POOLS);
const WALK_V4 = V4_MODE === "all" || V4_MODE === "only" || (V4_MODE === "auto" && v4Listed.length > 0);
console.log(`backfill | ${pools.length} V3 pool(s)${WALK_V4 ? ` · V4 singleton (${v4Listed.length} pools seen trading)` : ""}`);

const TWO_96 = 2 ** 96;
const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;
const absInt256 = (word) => { const v = BigInt("0x" + word); const s = v >= TWO_255 ? v - TWO_256 : v; return s < 0n ? -s : s; };

const headerTs = new Map();
async function blockTime(bn) {
  if (headerTs.has(bn)) return headerTs.get(bn);
  const b = await rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
  const ts = parseInt(b.timestamp, 16);
  headerTs.set(bn, ts);
  return ts;
}

const started = Date.now();

/** The watcher writes the same database; when it holds the lock, wait and try again rather than die. */
async function withDb(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); } catch (e) {
      if (!/locked|busy/i.test(e.message) || attempt >= 30) throw e;
      await sleep(500 + attempt * 500);
    }
  }
}
const writeCandles = (points) => withDb(() => store.upsertCandles(points));

/** Where a pool's walk resumes: its checkpoint, else just before the recorder's tape. */
function resumeBlock(pool) {
  const saved = Number(store.getMeta(`backfill:${pool}`) ?? NaN);
  if (Number.isFinite(saved)) return saved;
  const cov = store.candleCoverage(pool);
  if (!cov) return head;
  const nowTs = Math.floor(Date.now() / 1000);
  return head - Math.ceil((nowTs - cov.from) * 10) - 600; // ~10 blocks/s, a minute of slack
}
/** The singleton's walk resumes at its own checkpoint, else just before the oldest V4 tape the recorder has. */
function resumeV4() {
  const saved = Number(store.getMeta("backfill:v4") ?? NaN);
  if (Number.isFinite(saved)) return saved;
  let oldest = Infinity;
  for (const p of v4Listed) { const cov = store.candleCoverage(p); if (cov) oldest = Math.min(oldest, cov.from); }
  if (!Number.isFinite(oldest)) return head;
  return head - Math.ceil((Math.floor(Date.now() / 1000) - oldest) * 10) - 600;
}

/**
 * One walk for every pool at once.
 *
 * eth_getLogs takes an array of addresses, and the cost of a query is driven by
 * the logs it returns, not the number of contracts asked about. Walking each
 * pool separately therefore re-scanned the same 52M blocks sixty times over;
 * asking for all of them together scans the range once, which is the difference
 * between a backfill that finishes and one that does not.
 */
async function backfillAll(pools) {
  const active = pools.filter((p) => resumeBlock(p) > floorBlock);
  const v4From = WALK_V4 ? resumeV4() : -1;
  const v4Active = v4From > floorBlock;
  if (!active.length && !v4Active) return { logs: 0, minutes: 0 };
  let hi = Math.max(...active.map(resumeBlock), v4Active ? v4From : -1);
  let span = Number(store.getMeta("backfill:span") ?? 2_000);
  let logsTotal = 0, minutes = 0, windows = 0, lastReport = Date.now(), reachedTs = 0;

  while (hi > floorBlock) {
    // A round is PARALLEL adjacent windows in flight at once. Against a
    // throttled endpoint one is all we get; against an archive plan with
    // headroom this is what turns a fortnight into an afternoon. Windows are
    // still consumed newest-first, so the checkpoint stays a truthful "every
    // block above this is done".
    const ranges = [];
    let cursor = hi;
    for (let k = 0; k < PARALLEL && cursor > floorBlock; k++) {
      const lo = Math.max(floorBlock, cursor - span + 1);
      ranges.push({ lo, hi: cursor });
      cursor = lo - 1;
    }

    // Each window is turned into candles the moment it lands, rather than
    // holding every response until the whole round resolves. A window here can
    // be a hundred thousand logs, and the app server has three gigabytes.
    let widest = 0, tooWide = null;
    try {
      windows += ranges.length;
      await Promise.all(ranges.map(async ({ lo, hi: rHi }) => {
        const range = { fromBlock: "0x" + lo.toString(16), toBlock: "0x" + rHi.toString(16) };
        // Each venue's swaps this window; a venue whose resume point is below the window is skipped.
        const asks = [];
        if (active.length && rHi <= Math.max(...active.map(resumeBlock))) asks.push(rpc("eth_getLogs", [{ address: active, topics: [V3_SWAP_TOPIC], ...range }]).then((ls) => ls.map((l) => [l.address.toLowerCase(), l])));
        if (v4Active && rHi <= v4From) asks.push(rpc("eth_getLogs", [{ address: V4_POOL_MANAGER, topics: [V4_SWAP_TOPIC], ...range }]).then((ls) => ls.map((l) => [l.topics[1]?.toLowerCase(), l])));
        const logs = (await Promise.all(asks)).flat();
        widest = Math.max(widest, logs.length);
        if (!logs.length) return;
        const [tLo, tHi] = await Promise.all([blockTime(lo), blockTime(rHi)]);
        reachedTs = tLo;
        const perBlock = rHi > lo ? (tHi - tLo) / (rHi - lo) : 0;
        const points = [];
        for (const [pool, l] of logs) {
          if (!pool) continue;
          const data = l.data.slice(2);
          if (data.length < 5 * 64) continue;
          const sqrt = Number(BigInt("0x" + data.slice(128, 192)));
          const price = (sqrt / TWO_96) ** 2;
          if (!Number.isFinite(price) || price <= 0) continue;
          const bn = Number(BigInt(l.blockNumber));
          const ts = Math.round(tLo + (bn - lo) * perBlock);
          points.push({ pool, bucket: Math.floor(ts / 60) * 60, price, vol0: Number(absInt256(data.slice(0, 64))), vol1: Number(absInt256(data.slice(64, 128))), block: bn });
        }
        logs.length = 0;
        await writeCandles(points);
        minutes += new Set(points.map((x) => x.pool + ":" + x.bucket)).size;
        logsTotal += points.length;
      }));
    } catch (e) {
      if (isTooWide(e) && span > 100) tooWide = e; else throw new Error(`getLogs refused at ${span} blocks: ${e.message}`);
    }
    if (tooWide) {
      spanCeiling = Math.min(spanCeiling, span);
      span = Math.max(100, Math.floor(span / 2));
      continue;
    }

    hi = ranges[ranges.length - 1].lo - 1;

    // Checkpoint every pool, but never move one backwards: a pool walked
    // further by an earlier run keeps the progress it already has.
    await withDb(() => {
      for (const pool of active) {
        const key = `backfill:${pool}`;
        const cur = Number(store.getMeta(key) ?? NaN);
        if (!Number.isFinite(cur) || hi < cur) store.setMeta(key, String(hi));
      }
      if (v4Active) {
        const cur = Number(store.getMeta("backfill:v4") ?? NaN);
        if (!Number.isFinite(cur) || hi < cur) store.setMeta("backfill:v4", String(hi));
      }
    });

    const roof = Math.max(100, spanCeiling - 1);
    if (widest < MAX_LOGS / 2 && span < roof) span = Math.min(roof, Math.ceil(span * 1.5));
    else if (widest > MAX_LOGS) span = Math.max(100, Math.floor(span / 2));
    await withDb(() => store.setMeta("backfill:span", String(span)));

    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      const pct = (100 * (head - hi)) / Math.max(1, head - floorBlock);
      const rate = (head - hi) / Math.max(0.001, (Date.now() - started) / 3_600_000);
      const eta = rate > 0 ? (hi - floorBlock) / rate : 0;
      const at = reachedTs ? new Date(reachedTs * 1000).toISOString().slice(0, 16).replace("T", " ") : "?";
      console.log(`backfill | reached ${at} (block ${hi}, ${pct.toFixed(1)}% of range) · ${logsTotal.toLocaleString()} swaps → ${minutes.toLocaleString()} candle writes · window ${span}/${spanCeiling}x${PARALLEL} · ${windows} windows · ${throttles} throttled · eta ${eta.toFixed(1)}h`);
    }
  }
  return { logs: logsTotal, minutes };
}

const r = await backfillAll(pools);
console.log(`backfill | finished ${pools.length} pools · ${r.logs.toLocaleString()} swaps → ${r.minutes.toLocaleString()} candle writes in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
store.close();
