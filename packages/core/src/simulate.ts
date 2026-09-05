import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { SWAP_TOPICS } from "./index.ts";

/**
 * Execution simulation and hint extraction.
 *
 * `eth_simulateV1` (supported by Robinhood Chain) returns the LOGS a call would
 * emit. That is the difference between guessing a pending transaction's venue
 * from its `to` address and actually naming the pools it will move — including
 * pools reached through a router nobody has catalogued.
 *
 * What gets broadcast to searchers is deliberately narrow. A backrun needs to
 * know which pool moved and in which direction; it does not need the size, and
 * size is exactly what would let someone reconstruct and front-run the trade.
 * Amounts are therefore withheld unless the hint level is explicitly `full`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimLog {
  address: string;
  topics: string[];
  data: string;
}

export interface SimTxResult {
  /** The transaction executed successfully. */
  ok: boolean;
  /** Simulation could not be performed at all (unsupported, rate limited, ...). */
  degraded: boolean;
  logs: SimLog[];
  gasUsed: bigint;
  revertReason?: string;
}

/**
 * How much of a pending transaction is revealed to searchers.
 * - `minimal` — no pools at all, only the calldata shape the caller already has.
 * - `pools`   — which pool moved and which way (enough to price a backrun).
 * - `full`    — adds signed amounts (enables sizing, and front-running).
 */
export type HintLevel = "minimal" | "pools" | "full";

export interface SwapHint {
  kind: "univ2" | "univ3" | "univ4";
  /** Emitting contract: the pool itself for v2/v3, the PoolManager for v4. */
  pool: string;
  /** v4 identifies pools by PoolId rather than address. */
  poolId?: string;
  /**
   * Which market a v4 pool actually is, filled in by whoever has the pool
   * index (the auction does; see `withV4Keys`).
   *
   * Without this a v4 hint is unusable. `pool` is the PoolManager for every v4
   * swap on the chain, so a searcher reading addresses sees one shared pool and
   * cannot tell GME/WETH from anything else, and `poolId` is a hash it cannot
   * invert without having indexed every Initialize event itself. Since v4 is
   * where nearly all of this chain's arbitrage lives, a hint without the key is
   * a hint nobody can bid on.
   */
  key?: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  /** Undefined when the log was malformed and the direction can't be trusted. */
  direction?: "0for1" | "1for0";
  /** Signed pool-side deltas, only present at hint level `full`. */
  amount0?: string;
  amount1?: string;
}

/** Somewhere that can turn v4 PoolIds into their keys — the shared store, in practice. */
export interface V4Keys {
  v4PoolsByIds(ids: string[]): Map<string, { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }>;
}

/**
 * Name the v4 pools in a set of hints. Unknown ids are left alone rather than
 * dropped: a searcher that has its own index can still use the poolId.
 */
export function withV4Keys(hints: SwapHint[], index: V4Keys | null): SwapHint[] {
  const ids = hints.filter((h) => h.kind === "univ4" && h.poolId).map((h) => h.poolId!);
  if (!index || !ids.length) return hints;
  let keys: Map<string, SwapHint["key"]>;
  try {
    keys = index.v4PoolsByIds(ids) as Map<string, SwapHint["key"]>;
  } catch {
    return hints;
  }
  return hints.map((h) => {
    const k = h.poolId ? keys.get(h.poolId) : undefined;
    return k ? { ...h, key: k } : h;
  });
}

export function hintLevelFromEnv(): HintLevel {
  const raw = (process.env.ORDO_HINT_LEVEL ?? "pools").toLowerCase();
  return raw === "minimal" || raw === "full" ? raw : "pools";
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

type RpcFn = (method: string, params: unknown[]) => Promise<any>;

/**
 * Replay a signed transaction at head without broadcasting it.
 *
 * The sender's balance is overridden so a value-bearing swap isn't rejected for
 * funding, and validation is disabled so a stale nonce doesn't mask the result.
 */
export async function simulateTx(
  rpc: RpcFn,
  signedTx: string,
  opts: { fundSender?: boolean; block?: string } = {},
): Promise<SimTxResult> {
  const empty: SimTxResult = { ok: false, degraded: true, logs: [], gasUsed: 0n };

  let call: Record<string, string>;
  let from: string;
  try {
    const tx = parseTransaction(signedTx as TransactionSerialized);
    from = await recoverTransactionAddress({ serializedTransaction: signedTx as TransactionSerialized });
    call = { from };
    if (tx.to) call.to = tx.to;
    if (tx.data && tx.data !== "0x") call.data = tx.data;
    if (tx.value !== undefined && tx.value > 0n) call.value = "0x" + tx.value.toString(16);
    if (tx.gas !== undefined) call.gas = "0x" + tx.gas.toString(16);
  } catch {
    return empty;
  }

  const stateOverrides =
    opts.fundSender === false ? undefined : { [from]: { balance: "0x56bc75e2d63100000" } }; // 100 ether

  let result: any;
  try {
    result = await rpc("eth_simulateV1", [
      { blockStateCalls: [{ ...(stateOverrides ? { stateOverrides } : {}), calls: [call] }], validation: false },
      opts.block ?? "latest",
    ]);
  } catch {
    return empty; // unsupported endpoint, rate limited, transport failure
  }

  const out = result?.[0]?.calls?.[0];
  if (!out) return empty;

  const ok = out.status === "0x1";
  return {
    ok,
    degraded: false,
    logs: (out.logs ?? []).map((l: any) => ({ address: l.address, topics: l.topics ?? [], data: l.data ?? "0x" })),
    gasUsed: BigInt(out.gasUsed ?? "0x0"),
    revertReason: ok ? undefined : (out.error?.message ?? out.returnData ?? "reverted"),
  };
}

// ---------------------------------------------------------------------------
// Swap hint extraction
// ---------------------------------------------------------------------------

/** Read the nth 32-byte word of a log's data as an unsigned integer. */
function word(data: string, index: number): bigint | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const start = index * 64;
  if (hex.length < start + 64) return null;
  return BigInt("0x" + hex.slice(start, start + 64));
}

/** Same, reinterpreted as a two's-complement signed integer. */
function signedWord(data: string, index: number): bigint | null {
  const raw = word(data, index);
  if (raw === null) return null;
  return raw >= 1n << 255n ? raw - (1n << 256n) : raw;
}

function decode(log: SimLog, kind: string): SwapHint | null {
  const pool = log.address.toLowerCase();

  if (kind === "univ2") {
    // Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to)
    const a0In = word(log.data, 0);
    const a1In = word(log.data, 1);
    const a0Out = word(log.data, 2);
    const a1Out = word(log.data, 3);
    if (a0In === null || a1In === null || a0Out === null || a1Out === null) return { kind: "univ2", pool };
    return {
      kind: "univ2",
      pool,
      direction: a0In > 0n ? "0for1" : a1In > 0n ? "1for0" : undefined,
      // Normalised to the same pool-side delta convention v3 uses.
      amount0: (a0In - a0Out).toString(),
      amount1: (a1In - a1Out).toString(),
    };
  }

  if (kind === "univ3") {
    // Swap(sender, recipient, int256 amount0, int256 amount1, ...)
    // Amounts are the POOL's delta: positive amount0 means token0 came in.
    const a0 = signedWord(log.data, 0);
    const a1 = signedWord(log.data, 1);
    if (a0 === null || a1 === null) return { kind: "univ3", pool };
    return {
      kind: "univ3",
      pool,
      direction: a0 > 0n ? "0for1" : a0 < 0n ? "1for0" : undefined,
      amount0: a0.toString(),
      amount1: a1.toString(),
    };
  }

  // univ4: Swap(PoolId indexed id, address indexed sender, int128 amount0, ...)
  // Amounts are the SWAPPER's delta, so the sign is inverted versus v3:
  // paying token0 in shows as a negative amount0.
  const poolId = log.topics[1];
  const a0 = signedWord(log.data, 0);
  const a1 = signedWord(log.data, 1);
  if (a0 === null || a1 === null) return { kind: "univ4", pool, ...(poolId ? { poolId } : {}) };
  return {
    kind: "univ4",
    pool,
    ...(poolId ? { poolId } : {}),
    direction: a0 < 0n ? "0for1" : a0 > 0n ? "1for0" : undefined,
    amount0: a0.toString(),
    amount1: a1.toString(),
  };
}

/**
 * Turn simulated logs into the hint broadcast to searchers.
 * Non-swap logs are ignored, and a router touching one pool repeatedly
 * collapses to a single entry.
 */
export function extractSwapHints(logs: SimLog[], level: HintLevel = "pools"): SwapHint[] {
  if (level === "minimal") return [];

  const seen = new Map<string, SwapHint>();
  for (const log of logs ?? []) {
    const kind = SWAP_TOPICS[log.topics?.[0]?.toLowerCase() ?? ""];
    if (!kind) continue;

    const hint = decode(log, kind);
    if (!hint) continue;

    const key = hint.poolId ?? hint.pool;
    if (seen.has(key)) continue;

    if (level !== "full") {
      delete hint.amount0;
      delete hint.amount1;
    }
    seen.set(key, hint);
  }
  return [...seen.values()];
}
