import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINTS } from "@ordofi/core";
import { analyzeBlock } from "./detect.js";

const RPC = ENDPOINTS.rpc;
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");
const POLL_MS = Number(process.env.ORDO_POLL_MS ?? 400);
const BLOCK_DELAY_MS = Number(process.env.ORDO_BLOCK_DELAY_MS ?? 150);
const SUMMARY_EVERY_BLOCKS = Number(process.env.ORDO_SUMMARY_BLOCKS ?? 100);

mkdirSync(DATA_DIR, { recursive: true });
const swapsFile = join(DATA_DIR, "swaps.ndjson");
const arbsFile = join(DATA_DIR, "arbs.ndjson");
const checkpointFile = join(DATA_DIR, "checkpoint.json");

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

let rpcId = 0;
async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}

async function getReceipts(blockHex: string): Promise<any[] | null> {
  try {
    return await rpc("eth_getBlockReceipts", [blockHex]);
  } catch {
    return null; // node doesn't support it; caller falls back per-tx
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

function printSummary(head: number) {
  const mins = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  const topSenders = [...stats.arbSenders.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([a, n]) => `${a.slice(0, 10)}…×${n}`)
    .join(" ");
  const profit = [...stats.arbProfitByToken.entries()]
    .map(([t, v]) => `${t.slice(0, 10)}…=${v.toString()}`)
    .join(" ");
  console.log(
    `[summary] head=${head} uptime=${mins}m blocks=${stats.blocksSeen} txs=${stats.txsSeen} ` +
      `swaps=${stats.swapsSeen} pools=${stats.poolsSeen.size} arbs=${stats.arbsSeen}`,
  );
  if (stats.arbsSeen > 0) {
    console.log(`[summary] arb profit (wei by token): ${profit}`);
    console.log(`[summary] top arb senders: ${topSenders}`);
  }
}

async function processBlock(n: number): Promise<void> {
  const hex = "0x" + n.toString(16);
  const block = await rpc<any>("eth_getBlockByNumber", [hex, false]);
  if (!block) return;
  const timestamp = parseInt(block.timestamp, 16);
  const txCount = block.transactions.length;
  stats.blocksSeen++;
  stats.txsSeen += txCount;
  if (txCount === 0) return;

  let receipts = await getReceipts(hex);
  if (receipts === null) {
    receipts = await Promise.all(
      block.transactions.map((h: string) => rpc("eth_getTransactionReceipt", [h])),
    );
  }

  const { swaps, arbs } = analyzeBlock(n, timestamp, receipts as any[]);
  stats.swapsSeen += swaps.length;
  stats.arbsSeen += arbs.length;
  for (const s of swaps) stats.poolsSeen.add(s.pool);
  if (swaps.length > 0)
    appendFileSync(swapsFile, swaps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  for (const a of arbs) {
    stats.arbSenders.set(a.sender, (stats.arbSenders.get(a.sender) ?? 0) + 1);
    if (a.profitToken && a.profitWei) {
      stats.arbProfitByToken.set(
        a.profitToken,
        (stats.arbProfitByToken.get(a.profitToken) ?? 0n) + BigInt(a.profitWei),
      );
    }
    appendFileSync(arbsFile, JSON.stringify(a) + "\n");
    console.log(
      `[arb] block=${a.block} tx=${a.txHash} sender=${a.sender} pools=${a.poolsTouched.length} ` +
        `profit=${a.profitWei} of ${a.profitToken}`,
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

  for (;;) {
    try {
      const head = parseInt(await rpc<string>("eth_blockNumber"), 16);
      // Cap catch-up batches so we never hammer the public RPC.
      const target = Math.min(head, next + 10);
      while (next <= target) {
        await processBlock(next);
        if (next % SUMMARY_EVERY_BLOCKS === 0) printSummary(head);
        next++;
        if (next % 25 === 0) saveCheckpoint(next);
        // Throttle so backfills don't trip the public RPC's rate limit.
        if (BLOCK_DELAY_MS > 0) await new Promise((r) => setTimeout(r, BLOCK_DELAY_MS));
      }
    } catch (err) {
      console.error(`[error] ${(err as Error).message} — retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
