import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINTS, rpcFetch } from "@ordofi/core";
import { OrdoStore } from "@ordofi/store";
import { analyzeBlock } from "./detect.js";
import { extractPricePoints, extractTrades } from "./candles.js";

const RPC = ENDPOINTS.rpc;
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");
const POLL_MS = Number(process.env.ORDO_POLL_MS ?? 400);
const SUMMARY_EVERY_BLOCKS = Number(process.env.ORDO_SUMMARY_BLOCKS ?? 100);

/**
 * This chain produces ten blocks a second, so anything slower than that is not
 * a slow indexer — it is an indexer that never arrives. The previous settings
 * (ten blocks per pass, two round trips each, a 150ms sleep per block and a
 * 400ms poll between passes) came to roughly 3.4 blocks/s, and the index fell
 * about forty minutes further behind every hour.
 *
 * Blocks are now fetched concurrently and the per-block sleep is gone. The
 * throttling it provided has not been thrown away, just moved: concurrency
 * halves on any failure and recovers on success, so a rate limit costs
 * throughput for a few seconds instead of being paid for on every block
 * forever.
 */
const CONCURRENCY = Number(process.env.ORDO_CONCURRENCY ?? 8);
const MAX_BATCH = Number(process.env.ORDO_MAX_BATCH ?? 400);
const BLOCK_DELAY_MS = Number(process.env.ORDO_BLOCK_DELAY_MS ?? 0);
/** Per-arb lines are ~8/block at head; useful when debugging, noise otherwise. */
const LOG_ARBS = process.env.ORDO_LOG_ARBS === "1";

mkdirSync(DATA_DIR, { recursive: true });
const swapsFile = join(DATA_DIR, "swaps.ndjson");
const arbsFile = join(DATA_DIR, "arbs.ndjson");
const checkpointFile = join(DATA_DIR, "checkpoint.json");

// NDJSON stays as the append-only raw record; the index is what gets queried.
// Inserts are idempotent, so replaying a block after a restart is harmless.
const store = new OrdoStore(process.env.ORDO_DB ?? join(DATA_DIR, "ordo.db"));

function loadCheckpoint(): number | null {
  try {
    const { nextBlock } = JSON.parse(readFileSync(checkpointFile, "utf8"));
    return typeof nextBlock === "number" ? nextBlock : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(nextBlock: number): void {
  writeFileSync(checkpointFile, JSON.stringify({ nextBlock, savedAt: new Date().toISOString() }));
}

async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  return (await rpcFetch(method, params)) as T;
}

/**
 * Returns null only when the node genuinely lacks the method. Swallowing every
 * error here meant a rate-limited batch call silently became one call per
 * transaction — the response to being throttled was to make more requests.
 */
async function getReceipts(blockHex: string): Promise<any[] | null> {
  try {
    return await rpc("eth_getBlockReceipts", [blockHex]);
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (msg.includes("method not found") || msg.includes("not supported") || msg.includes("unsupported")) {
      return null;
    }
    throw e;
  }
}

// Running totals for the measurement report.
const stats = {
  startedAt: Date.now(),
  blocksSeen: 0,
  txsSeen: 0,
  swapsSeen: 0,
  arbsSeen: 0,
  arbProfitByToken: new Map<string, bigint>(),
  arbSenders: new Map<string, number>(),
  poolsSeen: new Set<string>(),
};

function printSummary(head: number, next: number, concurrency: number) {
  const mins = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  const rate = stats.blocksSeen / Math.max(1, (Date.now() - stats.startedAt) / 1000);
  const lag = Math.max(0, head - next);
  const topSenders = [...stats.arbSenders.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([a, n]) => `${a.slice(0, 10)}…×${n}`)
    .join(" ");
  // Every token ever profited in was printed on one line, which ran to
  // hundreds of entries and buried everything else in the log.
  const profit = [...stats.arbProfitByToken.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, 8)
    .map(([t, v]) => `${t.slice(0, 10)}…=${v.toString()}`)
    .join(" ");
  console.log(
    `[summary] head=${head} lag=${lag} (${(lag * 0.1 / 60).toFixed(1)}m) rate=${rate.toFixed(1)}blk/s ` +
      `conc=${concurrency} uptime=${mins}m blocks=${stats.blocksSeen} txs=${stats.txsSeen} ` +
      `swaps=${stats.swapsSeen} pools=${stats.poolsSeen.size} arbs=${stats.arbsSeen}`,
  );
  if (stats.arbsSeen > 0) {
    console.log(`[summary] top arb profit (wei by token): ${profit}`);
    console.log(`[summary] top arb senders: ${topSenders}`);
  }
}

async function processBlock(n: number): Promise<void> {
  const hex = "0x" + n.toString(16);
  // Full transactions, not just hashes: `value` lives on the transaction and
  // not the receipt, and without it a trade paid for in native ETH looks free.
  const block = await rpc<any>("eth_getBlockByNumber", [hex, true]);
  if (!block) return;
  const timestamp = parseInt(block.timestamp, 16);
  const txCount = block.transactions.length;
  stats.blocksSeen++;
  stats.txsSeen += txCount;
  if (txCount === 0) return;

  const txValues = new Map<string, bigint>();
  for (const t of block.transactions) {
    if (t?.hash && t.value && t.value !== "0x0") txValues.set(t.hash.toLowerCase(), BigInt(t.value));
  }

  let receipts = await getReceipts(hex);
  if (receipts === null) {
    receipts = await Promise.all(
      block.transactions.map((t: any) => rpc("eth_getTransactionReceipt", [t.hash])),
    );
  }

  const { swaps, arbs } = analyzeBlock(n, timestamp, receipts as any[], txValues);
  // The tape for the trade terminal's charts: recorded here because the
  // receipts are already in hand, where re-reading them later via
  // eth_getLogs hits public endpoints' 10k-result caps within minutes.
  try {
    store.upsertCandles(extractPricePoints(n, timestamp, receipts as any[]));
    store.insertTrades(extractTrades(n, timestamp, receipts as any[]));
  } catch {
    /* charts must never stall the indexer */
  }
  stats.swapsSeen += swaps.length;
  stats.arbsSeen += arbs.length;
  for (const s of swaps) stats.poolsSeen.add(s.pool);
  if (swaps.length > 0)
    appendFileSync(swapsFile, swaps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  store.addSwaps(swaps.length);
  for (const a of arbs) {
    stats.arbSenders.set(a.sender, (stats.arbSenders.get(a.sender) ?? 0) + 1);
    if (a.profitToken && a.profitWei) {
      stats.arbProfitByToken.set(
        a.profitToken,
        (stats.arbProfitByToken.get(a.profitToken) ?? 0n) + BigInt(a.profitWei),
      );
    }
    appendFileSync(arbsFile, JSON.stringify(a) + "\n");
    if (LOG_ARBS) {
      console.log(
        `[arb] block=${a.block} tx=${a.txHash} sender=${a.sender} pools=${a.poolsTouched.length} ` +
          `profit=${a.profitWei} of ${a.profitToken}`,
      );
    }
  }

  if (arbs.length > 0) {
    store.insertArbs(
      arbs.map((a) => ({
        txHash: a.txHash,
        block: a.block,
        timestamp: a.timestamp,
        sender: a.sender,
        pools: a.poolsTouched,
        profitToken: a.profitToken,
        profitWei: a.profitWei,
        profitIsQuote: a.profitIsQuote,
        gasPaidWei: a.gasPaidWei,
      })),
    );
  }
}

async function main() {
  const startHex = await rpc<string>("eth_blockNumber");
  const head0 = parseInt(startHex, 16);
  const backfill = Number(process.env.ORDO_BACKFILL ?? 0);
  // Resume from checkpoint if present (unless it's absurdly far behind head),
  // otherwise start at head minus requested backfill.
  const checkpoint = loadCheckpoint();
  let next =
    checkpoint !== null && head0 - checkpoint < 500_000 ? checkpoint : head0 - backfill;
  console.log(
    `ordo watcher | rpc=${RPC} | starting at block ${next} ` +
      `(${checkpoint !== null ? "resumed from checkpoint" : `backfill=${backfill}`})`,
  );
  console.log(`ordo watcher | writing ${swapsFile} and ${arbsFile}`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let consecutiveFailures = 0;
  let concurrency = CONCURRENCY;
  let goodChunks = 0;
  let lastSaved = next;
  let lastSummary = next;

  for (;;) {
    try {
      const head = parseInt(await rpc<string>("eth_blockNumber"), 16);
      if (next > head) {
        await sleep(POLL_MS); // caught up; wait for the chain rather than spin
        continue;
      }

      const target = Math.min(head, next + MAX_BATCH - 1);
      while (next <= target) {
        const chunk: number[] = [];
        for (let b = next; b <= target && chunk.length < concurrency; b++) chunk.push(b);
        // All or nothing: a partial chunk would advance the checkpoint past a
        // block that was never indexed. Retrying the whole chunk is safe
        // because every insert is idempotent.
        await Promise.all(chunk.map(processBlock));
        next += chunk.length;

        if (next - lastSaved >= 25) {
          saveCheckpoint(next);
          lastSaved = next;
        }
        if (next - lastSummary >= SUMMARY_EVERY_BLOCKS) {
          printSummary(head, next, concurrency);
          lastSummary = next;
          // Rolling three-day tape; beyond that the chart never asks.
          store.pruneCandles(Math.floor(Date.now() / 1000) - 3 * 86_400);
          store.pruneTrades(Math.floor(Date.now() / 1000) - 2 * 3_600);
        }
        // Additive increase, multiplicative decrease. Recovering only after a
        // whole 400-block batch would have left concurrency pinned at 1 for as
        // long as the endpoint stayed busy, which is slower than the fixed
        // delay this replaced.
        if (++goodChunks >= 20 && concurrency < CONCURRENCY) {
          concurrency++;
          goodChunks = 0;
          console.log(`[recover] concurrency up to ${concurrency}`);
        }
        if (BLOCK_DELAY_MS > 0) await sleep(BLOCK_DELAY_MS);
      }

      saveCheckpoint(next);
      lastSaved = next;
      consecutiveFailures = 0;
    } catch (err) {
      // A flat 2s retry kept the IP hot enough that Cloudflare's challenge
      // never expired. Backing off exponentially is what actually ends a
      // 403 episode; capping it keeps recovery reasonably prompt. Halving
      // concurrency means a rate limit costs less on the way back up.
      consecutiveFailures++;
      concurrency = Math.max(1, Math.floor(concurrency / 2));
      goodChunks = 0;
      const waitMs = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveFailures - 1, 5));
      console.error(
        `[error] ${(err as Error).message} — backing off ${Math.round(waitMs / 1000)}s ` +
          `(failure ${consecutiveFailures}, concurrency ${concurrency})`,
      );
      await sleep(waitMs);
    }
  }
}

main();
