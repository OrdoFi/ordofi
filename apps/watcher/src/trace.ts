import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINTS, ETH_USD, type ArbObservation } from "@ordofi/core";

/**
 * Call-trace MEV profit analyzer.
 *
 * The Transfer-log heuristic in detect.ts robustly counts arbitrage ACTIVITY,
 * but can't see profit booked inside executor contracts. This module computes
 * the true per-transaction ETH profit using `debug_traceTransaction` with the
 * prestateTracer in diff mode: the searcher's realized profit is the net
 * increase in ETH balance across all addresses it controls in the tx.
 *
 * Requires a node exposing debug_* (our own Nitro node — the public RPC does
 * not). Detects unavailability and reports it rather than failing.
 */

const TRACE_RPC = process.env.ORDO_TRACE_RPC ?? ENDPOINTS.rpc;
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");

let rpcId = 0;
async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(TRACE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result as T;
}

export interface TraceProfit {
  txHash: string;
  ethProfitWei: string;
  usd: number;
  beneficiary: string;
}

/** True realized ETH profit for a tx via prestate diff. Throws if unsupported. */
export async function ethProfitFor(txHash: string): Promise<TraceProfit | null> {
  const diff = await rpc<{ pre: Record<string, any>; post: Record<string, any> }>(
    "debug_traceTransaction",
    [txHash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }],
  );
  if (!diff?.pre || !diff?.post) return null;

  let best = 0n;
  let beneficiary = "";
  for (const addr of Object.keys(diff.post)) {
    const preBal = BigInt(diff.pre[addr]?.balance ?? "0x0");
    const postBal = BigInt(diff.post[addr]?.balance ?? diff.pre[addr]?.balance ?? "0x0");
    const delta = postBal - preBal;
    if (delta > best) {
      best = delta;
      beneficiary = addr;
    }
  }
  return {
    txHash,
    ethProfitWei: best.toString(),
    usd: (Number(best) / 1e18) * ETH_USD,
    beneficiary,
  };
}

async function isTraceSupported(): Promise<boolean> {
  try {
    await rpc("debug_traceTransaction", [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      { tracer: "prestateTracer" },
    ]);
    return true;
  } catch (e: any) {
    // "not found"/execution errors mean the METHOD exists; -32601 means it doesn't.
    return e.code !== -32601 && !/does not exist|not available|method not found/i.test(e.message);
  }
}

async function main() {
  const supported = await isTraceSupported();
  if (!supported) {
    console.log(`trace: ${TRACE_RPC} does not expose debug_traceTransaction.`);
    console.log("trace: honest USD profit needs our own Nitro node (Phase 1b).");
    console.log("trace: set ORDO_TRACE_RPC to a trace-enabled node and re-run.");
    process.exit(0);
  }

  const arbs: ArbObservation[] = readFileSync(join(DATA_DIR, "arbs.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  console.log(`trace: analyzing ${arbs.length} arbs via prestate diff on ${TRACE_RPC}`);
  const out: TraceProfit[] = [];
  let totalUsd = 0;
  for (const a of arbs) {
    try {
      const p = await ethProfitFor(a.txHash);
      if (p && BigInt(p.ethProfitWei) > 0n) {
        out.push(p);
        totalUsd += p.usd;
      }
    } catch {
      /* skip individual failures */
    }
  }
  writeFileSync(join(DATA_DIR, "arbs-traced.ndjson"), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
  console.log(`trace: ${out.length} profitable arbs, total ~$${totalUsd.toFixed(2)} ETH-denominated profit`);
  console.log(`trace: written data/arbs-traced.ndjson`);
}

main().catch((e) => {
  console.error("trace failed:", e.message);
  process.exit(1);
});
