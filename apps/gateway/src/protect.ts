import {
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { RpcError } from "./errors.js";

export type Upstream = (method: string, params: unknown[]) => Promise<any>;

interface SimResult {
  ok: boolean;
  returnData?: string;
  revertReason?: string;
  from: string;
  to: string | null;
}

/**
 * Simulate a raw signed transaction via eth_call from the recovered sender.
 * This catches guaranteed reverts (bad slippage, expired deadlines, failed
 * approvals) before the tx hits the sequencer and burns gas.
 *
 * Limitation (inherent to Phase 1): state can change between simulation and
 * inclusion, so success here is a strong signal, not a guarantee.
 */
export async function simulateRaw(upstream: Upstream, rawTx: string): Promise<SimResult> {
  if (!rawTx?.startsWith("0x")) throw new RpcError(-32602, "expected raw signed tx hex");
  const tx = parseTransaction(rawTx as TransactionSerialized);
  const from = await recoverTransactionAddress({
    serializedTransaction: rawTx as TransactionSerialized,
  });

  const call: Record<string, string> = { from };
  if (tx.to) call.to = tx.to;
  if (tx.data) call.data = tx.data;
  if (tx.value !== undefined) call.value = "0x" + tx.value.toString(16);
  if (tx.gas !== undefined) call.gas = "0x" + tx.gas.toString(16);

  try {
    const returnData = await upstream("eth_call", [call, "latest"]);
    return { ok: true, returnData, from, to: tx.to ?? null };
  } catch (err) {
    return {
      ok: false,
      revertReason: (err as Error).message,
      from,
      to: tx.to ?? null,
    };
  }
}

export async function protectAndSend(upstream: Upstream, rawTx: string): Promise<string> {
  const sim = await simulateRaw(upstream, rawTx);
  if (!sim.ok) {
    throw new RpcError(
      -32000,
      `ordo: transaction would revert, not submitted: ${sim.revertReason}`,
      { ordoProtected: true },
    );
  }
  return upstream("eth_sendRawTransaction", [rawTx]);
}

export interface BundleResult {
  bundleId: string;
  txHashes: string[];
  atomic: false;
  note: string;
}

/**
 * Best-effort bundle for an FCFS chain: simulate every tx, then submit them
 * back-to-back with no await between sends so they arrive at the sequencer
 * as close together as possible. True atomicity requires sequencer
 * integration (Phase 2); callers must treat ordering as probabilistic.
 */
export async function sendBundle(
  upstream: Upstream,
  bundle: { txs: string[] },
): Promise<BundleResult> {
  if (!bundle?.txs?.length) throw new RpcError(-32602, "bundle.txs required");
  if (bundle.txs.length > 10) throw new RpcError(-32602, "max 10 txs per bundle");

  for (const [i, raw] of bundle.txs.entries()) {
    const sim = await simulateRaw(upstream, raw);
    if (!sim.ok) {
      throw new RpcError(-32000, `ordo: bundle tx[${i}] would revert: ${sim.revertReason}`, {
        failedIndex: i,
      });
    }
  }

  // Fire all sends in the same tick to minimize inter-arrival gap at the sequencer.
  const sends = bundle.txs.map((raw) => upstream("eth_sendRawTransaction", [raw]));
  const txHashes = await Promise.all(sends);

  return {
    bundleId: txHashes[0],
    txHashes,
    atomic: false,
    note: "FCFS best-effort ordering; sequencer-enforced atomicity lands in Phase 2",
  };
}
