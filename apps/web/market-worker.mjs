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
parentPort.on("message", ({ id, since }) => {
  try {
    const rows = stmt.all(since).map((r) => ({
      pool: r.pool, open: r.open, high: r.high, low: r.low, close: r.close,
      vol0: r.vol0, vol1: r.vol1, swaps: Number(r.swaps), firstBucket: Number(r.fb), lastBucket: Number(r.lb),
    }));
    parentPort.postMessage({ id, rows });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
