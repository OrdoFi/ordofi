/**
 * The market-list query ("every pool's day") off the event loop.
 *
 * node:sqlite is synchronous, and the query walks a million rows: run on the
 * main thread it held the server for seconds every minute, and every request
 * in flight waited with it. A worker with its own read-only connection runs
 * it instead; the main thread only receives rows. Falls back to the store's
 * own synchronous query if the worker cannot be started.
 */
import { Worker } from "node:worker_threads";

let file = null, worker = null, seq = 0;
const pending = new Map();

export function setMarketDb(dbFile) { file = dbFile; }

function ensure() {
  if (worker || !file) return worker;
  worker = new Worker(new URL("./market-worker.mjs", import.meta.url), { workerData: { file } });
  worker.on("message", (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.rows); });
  worker.on("error", (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; });
  worker.on("exit", () => { for (const p of pending.values()) p.reject(new Error("market worker exited")); pending.clear(); worker = null; });
  worker.unref();
  return worker;
}

/** Same rows as `store.marketStats(since)`, without blocking. */
export async function marketStats(store, since) {
  const w = ensure();
  if (!w) return store?.marketStats?.(since) ?? [];
  try {
    return await new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.ref(); w.postMessage({ id, since }); }).finally(() => { if (!pending.size) worker?.unref(); });
  } catch {
    return store?.marketStats?.(since) ?? [];
  }
}
