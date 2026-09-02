import { V4, rpcFetch } from "@ordofi/core";
import type { OrdoStore, V4PoolRow } from "@ordofi/store";

/**
 * Uniswap V4 pool discovery.
 *
 * A V4 Swap log names its pool by PoolId, and the PoolId is a hash: nothing
 * about the pair can be read back out of it. The PoolManager announces each
 * pool's key exactly once, in its Initialize event, so the watcher has to see
 * every Initialize ever emitted to describe every pool it charts. Blocks the
 * live loop processes are covered as they arrive; everything before the live
 * loop's start is walked once, in the background, and checkpointed so a
 * restart resumes rather than starting over.
 */

const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

interface Log {
  address: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
}

function word(data: string, i: number): bigint {
  return BigInt("0x" + data.slice(i * 64, (i + 1) * 64));
}
function signed(data: string, i: number): bigint {
  const v = word(data, i);
  return v >= TWO_255 ? v - TWO_256 : v;
}
const topicAddress = (t: string) => ("0x" + t.slice(26)).toLowerCase();

/** Decode one Initialize log into a pool row, or null if it is not one. */
export function decodeInitialize(log: Log, block: number, ts?: number): V4PoolRow | null {
  if (log.address.toLowerCase() !== V4.poolManager) return null;
  const t = log.topics ?? [];
  if (t[0]?.toLowerCase() !== V4.initializeTopic || t.length < 4) return null;
  const data = (log.data ?? "0x").slice(2);
  // fee, tickSpacing, hooks, sqrtPriceX96, tick
  if (data.length < 5 * 64) return null;
  return {
    poolId: t[1].toLowerCase(),
    currency0: topicAddress(t[2]),
    currency1: topicAddress(t[3]),
    fee: Number(word(data, 0)),
    tickSpacing: Number(signed(data, 1)),
    hooks: ("0x" + data.slice(2 * 64 + 24, 3 * 64)).toLowerCase(),
    sqrtPrice: word(data, 3).toString(),
    tick: Number(signed(data, 4)),
    block,
    txHash: log.transactionHash,
    ts,
  };
}

/** Every pool initialised in one block's receipts. */
export function extractV4Initializes(
  block: number,
  timestamp: number,
  receipts: { transactionHash?: string; logs?: Log[] }[],
): V4PoolRow[] {
  const out: V4PoolRow[] = [];
  for (const r of receipts) {
    for (const log of r?.logs ?? []) {
      const row = decodeInitialize({ ...log, transactionHash: log.transactionHash ?? r.transactionHash }, block, timestamp);
      if (row) out.push(row);
    }
  }
  return out;
}

/** Where the historical walk has reached; the live loop advances it too once the walk is done. */
export const V4_SCANNED_KEY = "v4:initScannedTo";

export interface BackfillOptions {
  /** Last block to cover; the live loop owns everything after it. */
  toBlock: number;
  /** Widest eth_getLogs window to ask for. Chainstack allows 10k; smaller on refusal. */
  maxSpan?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (method: string, params: unknown[]) => Promise<any>;
}

/**
 * Walk Initialize events from the last checkpoint (or the PoolManager's
 * deploy block) up to `toBlock`, writing pool keys as they are found.
 *
 * Windows shrink when a provider refuses the range and grow back on success,
 * so a fallback endpoint with a tight cap slows the walk down rather than
 * pinning it small for good. Anything else — rate limits, transient errors —
 * is retried on the same window with a growing pause. Returns the block it
 * reached, which is `toBlock` unless it gave up.
 */
export async function backfillV4Pools(store: OrdoStore, opts: BackfillOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetch = opts.fetch ?? rpcFetch;
  const maxSpan = opts.maxSpan ?? 10_000;

  const saved = Number(store.getMeta(V4_SCANNED_KEY) ?? NaN);
  let from = Number.isFinite(saved) ? saved + 1 : V4.deployBlock;
  if (from > opts.toBlock) return opts.toBlock;

  log(`v4 | walking Initialize events ${from} → ${opts.toBlock} (${opts.toBlock - from + 1} blocks, ${store.v4PoolCount()} pools known)`);
  let span = maxSpan;
  let stuck = 0;
  let backoffMs = 0;
  let good = 0;
  let found = 0;
  let lastLog = Date.now();
  while (from <= opts.toBlock) {
    const to = Math.min(from + span - 1, opts.toBlock);
    let logs: Log[];
    try {
      logs = await fetch("eth_getLogs", [
        { address: V4.poolManager, topics: [V4.initializeTopic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
      ]);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // A window the provider will not serve is the one failure a smaller
      // window fixes; everything else is about when we asked, not what.
      if (/range|limit|exceed|too many|response size|more than|query returned|10000|-32602|invalid param/i.test(msg) && span > 100) {
        span = Math.max(100, Math.floor(span / 2));
        good = 0;
        continue;
      }
      if (++stuck > 40) {
        log(`v4 | Initialize walk stalled at block ${from}: ${msg.slice(0, 160)}`);
        return from - 1;
      }
      backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : 1_000, 30_000);
      await sleep(backoffMs);
      continue;
    }
    stuck = 0;
    backoffMs = 0;
    const rows: V4PoolRow[] = [];
    for (const l of logs) {
      const row = decodeInitialize(l, Number(BigInt(l.blockNumber ?? "0x0")));
      if (row) rows.push(row);
    }
    store.upsertV4Pools(rows);
    found += rows.length;
    store.setMeta(V4_SCANNED_KEY, String(to));
    from = to + 1;
    if (++good >= 5 && span < maxSpan) {
      span = Math.min(maxSpan, span * 2);
      good = 0;
    }
    if (Date.now() - lastLog > 30_000) {
      log(`v4 | Initialize walk at block ${from} (${(((from - V4.deployBlock) / Math.max(1, opts.toBlock - V4.deployBlock)) * 100).toFixed(1)}%), ${found} pools this run, span ${span}`);
      lastLog = Date.now();
    }
    // Back-to-back historical getLogs is what trips rate limiters; a short
    // breath between windows costs less than the backoff it avoids.
    await sleep(120);
  }
  log(`v4 | Initialize walk complete: ${found} pools this run, ${store.v4PoolCount()} known`);
  return opts.toBlock;
}
