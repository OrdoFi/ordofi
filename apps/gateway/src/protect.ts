import {
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { proveDelivery, type DeliveryProof } from "@ordofi/core/guard";
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
/** A raw transaction parsed and its sender recovered — once, shared by every check. */
export interface ParsedRaw {
  tx: ReturnType<typeof parseTransaction>;
  from: Hex;
}

export async function parseRaw(rawTx: string): Promise<ParsedRaw> {
  if (!rawTx?.startsWith("0x")) throw new RpcError(-32602, "expected raw signed tx hex");
  const tx = parseTransaction(rawTx as TransactionSerialized);
  // ECDSA recovery is the one CPU-heavy step on the send path; the checks
  // below used to each do their own.
  const from = await recoverTransactionAddress({ serializedTransaction: rawTx as TransactionSerialized });
  return { tx, from };
}

export async function simulateRaw(upstream: Upstream, rawTx: string, parsed?: ParsedRaw): Promise<SimResult> {
  const { tx, from } = parsed ?? (await parseRaw(rawTx));

  const call: Record<string, string> = { from };
  if (tx.to) call.to = tx.to;
  if (tx.data) call.data = tx.data;
  if (tx.value !== undefined) call.value = "0x" + tx.value.toString(16);
  // The sender's gas limit is deliberately NOT forwarded. `eth_call` charges
  // intrinsic gas out of the budget it is given, so a plain transfer carrying
  // exactly 21000 simulates as "out of gas" and a valid transaction gets
  // refused. Revert protection exists to catch logic failures — slippage, dead
  // deadlines, missing approvals — and whether the sender budgeted enough gas
  // is between them and the sequencer. Blocking a good transaction is a worse
  // outcome than letting an under-funded one through.

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

/**
 * Would this transaction pay an address nobody controls?
 *
 * A transaction can succeed and still lose the money: SwapRouter02's
 * `unwrapWETH9(amount, address(1))` sends ETH to the ecrecover precompile and
 * reports success. The revert check above cannot see that; this one executes
 * the transaction with eth_simulateV1 and looks at where the balances went.
 * Whatever frontend built the calldata, a black-hole payment is refused here.
 *
 * Returns null when the upstream cannot simulate: a public RPC that refuses
 * every send whenever one method is unavailable would be a worse outcome than
 * one that only refuses what it can prove is a loss.
 */
export async function burnCheck(upstream: Upstream, rawTx: string, parsed?: ParsedRaw): Promise<DeliveryProof | null> {
  const { tx, from } = parsed ?? (await parseRaw(rawTx));
  if (!tx.to) return null; // contract creation: nothing to misdirect
  const proof = await proveDelivery(
    { from, tx: { to: tx.to, data: (tx.data ?? "0x") as Hex, value: tx.value ?? 0n } },
    { simulate: (params) => upstream("eth_simulateV1", params) },
  );
  if (proof.unavailable) return null;
  return proof;
}

/**
 * One simulation answers both questions. eth_simulateV1 executes the
 * transaction and reports its status, so the separate eth_call that used to
 * run first was a second round trip for information the delivery check
 * already had. The send path is now simulate → send, two upstream calls
 * instead of three; eth_call remains as the fallback for an upstream that
 * cannot simulate, so revert protection never goes away.
 */
export async function protectAndSend(upstream: Upstream, rawTx: string): Promise<string> {
  await assertSafe(upstream, rawTx);
  return upstream("eth_sendRawTransaction", [rawTx]);
}

/**
 * Every check, and no send. Separate because the promise made to the sender —
 * we do not forward a transaction we can prove will revert or will pay an
 * address nobody controls — must not depend on which path the transaction then
 * takes. The auction dispatches the user's transaction itself, so a send routed
 * through it used to skip all of this.
 *
 * Throws the same RpcError `protectAndSend` throws; returns nothing when the
 * transaction is safe to broadcast.
 */
export async function assertSafe(upstream: Upstream, rawTx: string): Promise<void> {
  const parsed = await parseRaw(rawTx);
  const burn = await burnCheck(upstream, rawTx, parsed).catch(() => null);
  if (burn === null) {
    const sim = await simulateRaw(upstream, rawTx, parsed);
    if (!sim.ok) {
      throw new RpcError(
        -32000,
        `ordo: transaction would revert, not submitted: ${sim.revertReason}`,
        { ordoProtected: true },
      );
    }
  } else if (burn.reverted !== undefined) {
    throw new RpcError(
      -32000,
      `ordo: transaction would revert, not submitted: ${burn.reverted}`,
      { ordoProtected: true },
    );
  }
  if (burn && burn.leaks.length) {
    throw new RpcError(
      -32000,
      `ordo: transaction would send funds to an address nobody controls, not submitted: ${burn.reason}`,
      {
        ordoProtected: true,
        leaks: burn.leaks.map((l) => ({ to: l.to, asset: l.asset, amount: l.amount.toString() })),
        hint: "a recipient in the calldata is a precompile or the zero/dead address; SwapRouter02 sentinels (address(1)/address(2)) are only resolved inside swap functions, never by unwrapWETH9/sweepToken/refundETH",
      },
    );
  }
}

export interface BundleResult {
  bundleId: string;
  txHashes: string[];
  atomic: boolean;
  note: string;
  /** Present on a multi-transaction bundle: how to get real atomicity instead. */
  atomicAlternative?: string;
}

const BUNDLER = process.env.ORDO_BUNDLER_ADDRESS ?? "";

/** `executorOf(address)` and `isDeployed(address)` on `OrdoBundler`. */
const SEL_EXECUTOR_OF = "0x848676a2";
const SEL_IS_DEPLOYED = "0x90184b02";

export interface BundlerInfo {
  bundler: string | null;
  executor: string | null;
  deployed: boolean;
  note: string;
}

/**
 * Where an owner's atomic executor lives, deployed or not.
 *
 * The address is a CREATE2 derivation of the owner, so it is answerable before
 * the executor exists — which is what lets a searcher fund and approve it in
 * the same breath as deploying it.
 */
export async function bundlerInfo(upstream: Upstream, owner: string): Promise<BundlerInfo> {
  if (!BUNDLER) {
    return {
      bundler: null,
      executor: null,
      deployed: false,
      note: "no OrdoBundler configured; set ORDO_BUNDLER_ADDRESS",
    };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? "")) throw new RpcError(-32602, "expected an owner address");

  const arg = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const [executorWord, deployedWord] = await Promise.all([
    upstream("eth_call", [{ to: BUNDLER, data: SEL_EXECUTOR_OF + arg }, "latest"]),
    upstream("eth_call", [{ to: BUNDLER, data: SEL_IS_DEPLOYED + arg }, "latest"]),
  ]);

  return {
    bundler: BUNDLER,
    executor: "0x" + String(executorWord).slice(-40),
    deployed: BigInt(deployedWord as string) === 1n,
    note: "call OrdoBundler.deploy() once, then execute(calls, checks, maxBlock, minGainWei) for atomic bundles",
  };
}

/**
 * Submit a bundle.
 *
 * There are two honestly different things this can mean on a chain with one
 * first-come-first-served sequencer and no bundle endpoint:
 *
 *   - **One transaction through `OrdoExecutor`** is genuinely atomic. Every
 *     leg runs inside a single transaction, so either all of them land or none
 *     of them do, and `atomic: true` is returned. This is what a searcher
 *     should use for their own multi-leg work.
 *
 *   - **Several transactions from different senders** cannot be made atomic
 *     without the sequencer's cooperation, and nothing here pretends otherwise.
 *     They are simulated, then fired in the same tick to minimise the gap at
 *     the sequencer, and `atomic: false` is returned along with a pointer at
 *     the executor that would have made it atomic.
 *
 * `allowRevert` exists for the second case. A conditional backrun is *built*
 * to revert when the transaction it was meant to follow did not land, so
 * rejecting it for failing simulation would defeat the guard entirely.
 */
export async function sendBundle(
  upstream: Upstream,
  bundle: { txs: string[]; allowRevert?: boolean | number[] },
): Promise<BundleResult> {
  if (!bundle?.txs?.length) throw new RpcError(-32602, "bundle.txs required");
  if (bundle.txs.length > 10) throw new RpcError(-32602, "max 10 txs per bundle");

  const tolerated = (i: number): boolean =>
    bundle.allowRevert === true || (Array.isArray(bundle.allowRevert) && bundle.allowRevert.includes(i));

  let targetsExecutor = false;
  for (const [i, raw] of bundle.txs.entries()) {
    const sim = await simulateRaw(upstream, raw);
    if (BUNDLER && sim.to && sim.to.toLowerCase() === BUNDLER.toLowerCase()) targetsExecutor = true;
    if (!sim.ok && !tolerated(i)) {
      throw new RpcError(-32000, `ordo: bundle tx[${i}] would revert: ${sim.revertReason}`, {
        failedIndex: i,
        hint: "set allowRevert if this leg is a conditional backrun that is meant to be able to revert",
      });
    }
  }

  // Fire all sends in the same tick to minimize inter-arrival gap at the sequencer.
  const sends = bundle.txs.map((raw) => upstream("eth_sendRawTransaction", [raw]));
  const txHashes = await Promise.all(sends);

  const atomic = bundle.txs.length === 1;
  return {
    bundleId: txHashes[0],
    txHashes,
    atomic,
    note: atomic
      ? targetsExecutor
        ? "atomic: one transaction through OrdoExecutor, all legs succeed or none do"
        : "atomic by virtue of being a single transaction"
      : "FCFS best-effort ordering across senders; the sequencer decides adjacency",
    ...(atomic
      ? {}
      : {
          atomicAlternative: BUNDLER
            ? `route your own legs through your OrdoExecutor via OrdoBundler at ${BUNDLER} for all-or-nothing execution`
            : "deploy OrdoBundler and set ORDO_BUNDLER_ADDRESS to offer atomic single-sender bundles",
        }),
  };
}
