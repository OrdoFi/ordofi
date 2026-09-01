#!/usr/bin/env node
/**
 * Backfill the chart tape from chain history.
 *
 * The watcher records candles from the moment it starts; everything before
 * that has to be read back out of the pools' Swap events. Public endpoints
 * refuse those reads beyond ~128 blocks, so this needs an upstream with full
 * log history: our own Nitro node, or an archive-tier provider.
 *
 *   node scripts/backfill-candles.mjs --rpc http://node:8547 [--days 90] [--pools 500] [--pool 0x…]
 *
 * Walks each pool backwards from the recorder's earliest bucket (or the head)
 * in adaptive block windows, converts every V3 Swap into a minute candle, and
 * upserts into the same table the watcher writes. Progress is checkpointed
 * per pool in the meta table, so it can be stopped and resumed. Block times
 * come from headers at window edges, interpolated inside the window; at 0.1 s
 * blocks that is accurate to well under a minute.
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
const RPC = args.rpc ?? process.env.ORDO_ARCHIVE_RPC;
if (!RPC) {
  console.error("need --rpc <url with full eth_getLogs history> (or ORDO_ARCHIVE_RPC)");
  process.exit(2);
}
const DAYS = Number(args.days ?? 90);
const MAX_POOLS = Number(args.pools ?? 500);
const CONCURRENCY = Number(args.concurrency ?? 4);
const DB = process.env.ORDO_DB ?? join(import.meta.dirname, "../data/ordo.db");
const V3_SWAP_TOPIC = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
const BLOCKS_PER_DAY = 864_000; // 0.1 s blocks

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 80)}`); }
  if (body.error) throw Object.assign(new Error(body.error.message ?? "rpc error"), { code: body.error.code });
  return body.result;
}

const store = new OrdoStore(DB);
const head = parseInt(await rpc("eth_blockNumber", []), 16);
const floorBlock = Math.max(0, head - DAYS * BLOCKS_PER_DAY);
console.log(`backfill | rpc=${new URL(RPC).host} head=${head} floor=${floorBlock} (${DAYS}d) db=${DB}`);

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

  let span = 20_000;
  let logsTotal = 0, minutes = 0, calls = 0;
  while (hi > floorBlock) {
    const lo = Math.max(floorBlock, hi - span + 1);
    let logs;
    try {
      calls++;
      logs = await rpc("eth_getLogs", [{ address: pool, topics: [V3_SWAP_TOPIC], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) }]);
    } catch (e) {
      if (span > 500) { span = Math.floor(span / 2); continue; }
      throw new Error(`${pool}: getLogs refused even at ${span} blocks: ${e.message}`);
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
    else if (logs.length > 9_000) span = Math.max(1_000, Math.floor(span / 2));
  }
  return { pool, done: true, minutes, logs: logsTotal, calls };
}

let i = 0, done = 0;
const started = Date.now();
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
