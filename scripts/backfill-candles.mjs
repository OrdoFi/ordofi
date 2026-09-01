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
 *                                     [--concurrency 1] [--pace 400]
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
  if (next !== undefined && !next.startsWith("--")) { args[process.argv[k].slice(2)] = next; k++; }
  else args[process.argv[k].slice(2)] = "1";
}
const RPCS = (args.rpc ?? process.env.ORDO_ARCHIVE_RPC ?? "").split(",").map((u) => u.trim()).filter(Boolean);
if (RPCS.length === 0) {
  console.error("need --rpc <url with full eth_getLogs history> (or ORDO_ARCHIVE_RPC)");
  process.exit(2);
}
const ALL = args.all === "1";
const DAYS = Number(args.days ?? 90);
const MAX_POOLS = Number(args.pools ?? 500);
const CONCURRENCY = Number(args.concurrency ?? 2);
const PACE_MS = Number(args.pace ?? 600);
const DB = process.env.ORDO_DB ?? join(import.meta.dirname, "../data/ordo.db");
const V3_SWAP_TOPIC = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
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
console.log(`backfill | rpc=${RPCS.map((u) => new URL(u).host).join(",")} head=${head} floor=${floorBlock} (${ALL ? "all history" : DAYS + "d"}) pace=${PACE_MS}ms x${CONCURRENCY} db=${DB}`);

// Which pools: the busiest by recorded swaps, plus anything explicitly named.
let pools = [];
if (args.pool) pools = [args.pool.toLowerCase()];
else {
  const since = Math.floor(Date.now() / 1000) - 7 * 86_400;
  pools = store.marketStats(since).slice(0, MAX_POOLS).map((r) => r.pool.toLowerCase());
}
console.log(`backfill | ${pools.length} pool(s)`);

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

async function backfillPool(pool) {
  const key = `backfill:${pool}`;
  const cov = store.candleCoverage(pool);
  // Resume point: the checkpoint if one exists, else just before the
  // recorder's tape begins (found by its earliest bucket → block guess).
  let hi = Number(store.getMeta(key) ?? NaN);
  if (!Number.isFinite(hi)) {
    if (cov) {
      const nowTs = Math.floor(Date.now() / 1000);
      hi = head - Math.ceil((nowTs - cov.from) * 10) - 600; // 10 blocks/s, one minute of slack
    } else hi = head;
  }
  if (hi <= floorBlock) return { pool, done: true, minutes: 0, logs: 0 };

  // Start narrow: the busiest pool is ~2 swaps a block, and the public
  // endpoint refuses anything over 10,000 logs. Quiet stretches widen fast.
  let span = Number(store.getMeta(`${key}:span`) ?? 4_000);
  let logsTotal = 0, minutes = 0, poolCalls = 0, lastReport = Date.now();
  while (hi > floorBlock) {
    const lo = Math.max(floorBlock, hi - span + 1);
    let logs;
    try {
      poolCalls++;
      logs = await rpc("eth_getLogs", [{ address: pool, topics: [V3_SWAP_TOPIC], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) }]);
    } catch (e) {
      if (isTooWide(e) && span > 200) { span = Math.max(200, Math.floor(span / 2)); continue; }
      throw new Error(`${pool}: getLogs refused at ${span} blocks: ${e.message}`);
    }
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      console.log(`backfill | ${pool.slice(0, 10)} at block ${lo} · ${logsTotal} swaps → ${minutes} min-candles so far · window ${span} · ${poolCalls} calls`);
    }
    if (logs.length) {
      const [tLo, tHi] = await Promise.all([blockTime(lo), blockTime(hi)]);
      const perBlock = hi > lo ? (tHi - tLo) / (hi - lo) : 0;
      const points = [];
      for (const l of logs) {
        const data = l.data.slice(2);
        if (data.length < 5 * 64) continue;
        const sqrt = Number(BigInt("0x" + data.slice(128, 192)));
        const price = (sqrt / TWO_96) ** 2;
        if (!Number.isFinite(price) || price <= 0) continue;
        const bn = Number(BigInt(l.blockNumber));
        const ts = Math.round(tLo + (bn - lo) * perBlock);
        points.push({ pool, bucket: Math.floor(ts / 60) * 60, price, vol0: Number(absInt256(data.slice(0, 64))), vol1: Number(absInt256(data.slice(64, 128))), block: bn });
      }
      store.upsertCandles(points);
      minutes += new Set(points.map((p) => p.bucket)).size;
      logsTotal += logs.length;
    }
    hi = lo - 1;
    store.setMeta(key, String(hi));
    if (logs.length < 4_000 && span < 200_000) span *= 2;
    else if (logs.length > 8_000) span = Math.max(200, Math.floor(span / 2));
    store.setMeta(`${key}:span`, String(span));
  }
  return { pool, done: true, minutes, logs: logsTotal, calls: poolCalls };
}

let i = 0, done = 0;
const started = Date.now();
setInterval(() => console.log(`backfill | ${calls} calls, ${throttles} throttled, ${done}/${pools.length} pools done, ${((Date.now() - started) / 60_000).toFixed(0)} min`), 300_000).unref();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (i < pools.length) {
      const pool = pools[i++];
      try {
        const r = await backfillPool(pool);
        done++;
        console.log(`backfill | ${done}/${pools.length} ${pool} · ${r.logs} swaps → ${r.minutes} minute-candles (${r.calls ?? 0} calls)`);
      } catch (e) {
        console.warn(`backfill | ${pool} failed: ${e.message}`);
      }
    }
  }),
);
console.log(`backfill | finished ${done}/${pools.length} pools in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
store.close();
