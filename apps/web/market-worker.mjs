// Worker side of market-stats.mjs: one read-only connection, one prepared query.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec("PRAGMA busy_timeout = 8000");
// Kept identical to OrdoStore.marketStats, index hint included.
const stmt = db.prepare(
  `WITH w AS (
     SELECT pool, MIN(bucket) fb, MAX(bucket) lb, MAX(high) high, MIN(low) low,
            SUM(vol0) vol0, SUM(vol1) vol1, SUM(swaps) swaps
     FROM candles INDEXED BY candles_by_time WHERE bucket >= ? GROUP BY pool)
   SELECT w.pool, f.open, w.high, w.low, l.close, w.vol0, w.vol1, w.swaps, w.fb, w.lb
   FROM w
   JOIN candles f ON f.pool = w.pool AND f.bucket = w.fb
   JOIN candles l ON l.pool = w.pool AND l.bucket = w.lb
   ORDER BY w.swaps DESC`,
);
// Sparklines for the list: one pass over the window for a set of pools, the
// last close per `step` seconds, so eighty rows cost one query, not eighty.
const sparkStmt = (n) => db.prepare(`SELECT pool, bucket, close FROM candles WHERE pool IN (${Array(n).fill("?").join(",")}) AND bucket >= ? ORDER BY bucket`);
function sparks(pools, since, step) {
  const out = {};
  for (let i = 0; i < pools.length; i += 200) {
    const chunk = pools.slice(i, i + 200);
    for (const r of sparkStmt(chunk.length).all(...chunk, since)) {
      const s = (out[r.pool] ??= new Map());
      s.set(Math.floor(r.bucket / step), r.close);
    }
  }
  const first = Math.floor(since / step), last = Math.floor(Date.now() / 1000 / step);
  const res = {};
  for (const [pool, m] of Object.entries(out)) {
    const arr = []; let prev = null;
    for (let k = first; k <= last; k++) { const v = m.get(k); if (v != null) prev = v; if (prev != null) arr.push(prev); }
    res[pool] = arr;
  }
  return res;
}
parentPort.on("message", ({ id, since, kind, pools, step }) => {
  if (kind === "sparks") {
    try { parentPort.postMessage({ id, rows: sparks(pools, since, step) }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
    return;
  }
  try {
    const rows = stmt.all(since).map((r) => ({
      pool: r.pool, open: r.open, high: r.high, low: r.low, close: r.close,
      vol0: r.vol0, vol1: r.vol1, swaps: Number(r.swaps), firstBucket: Number(r.fb), lastBucket: Number(r.lb),
    }));
    parentPort.postMessage({ id, rows });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
