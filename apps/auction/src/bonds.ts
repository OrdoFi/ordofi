import { createPublicClient, http, type Hex } from "viem";
import { ENDPOINTS, robinhoodChain } from "@ordofi/core";

/**
 * Bond gating. A bid is only worth accepting if the searcher has enough ETH
 * bonded in OrdoSettlement to actually pay it — otherwise settlement reverts
 * and the auction has sold something it can't collect on.
 *
 * Two things a researcher pointed out this used to get wrong:
 *
 *   - It read `bond`, which a searcher could withdraw the instant their
 *     back-run landed. The contract now has a withdrawal delay and exposes
 *     `collateral()` — the bond less anything on its way out — and that is
 *     what is read here.
 *   - It reserved nothing, so one bond could back several concurrent wins.
 *     Now an accepted bid holds its amount against the searcher until the
 *     auction resolves; a win keeps holding the clearing price until its
 *     settlement has been attempted. What is free to bid with is collateral
 *     minus those holds.
 *
 * Until ORDO_SETTLEMENT_ADDRESS is configured, gating is disabled and all bids
 * are accepted (Phase 1 behaviour, before the contract is deployed).
 */

const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS as Hex | undefined;
const CACHE_TTL_MS = Number(process.env.ORDO_BOND_CACHE_MS ?? 5_000);
/** A hold nobody released (a crash mid-auction) expires rather than locking a searcher out. */
const HOLD_TTL_MS = Number(process.env.ORDO_BOND_HOLD_TTL_MS ?? 60_000);

const ABI = [
  {
    type: "function",
    name: "collateral",
    stateMutability: "view",
    inputs: [{ name: "searcher", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const client = createPublicClient({ chain: robinhoodChain, transport: http(ENDPOINTS.rpc) });
const cache = new Map<string, { value: bigint; at: number }>();
/** key `${searcher}:${opportunityId}` → held wei */
const holds = new Map<string, { searcher: string; wei: bigint; at: number }>();

export function bondingEnabled(): boolean {
  return Boolean(SETTLEMENT);
}

/** What the contract will lend against right now: bond less pending withdrawal. */
export async function collateralOf(searcher: string): Promise<bigint> {
  if (!SETTLEMENT) return 0n;
  const key = searcher.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const value = await client.readContract({ address: SETTLEMENT, abi: ABI, functionName: "collateral", args: [searcher as Hex] });
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch {
    return 0n;
  }
}

/** Sum of live holds on a searcher, dropping any that have expired. */
export function heldBy(searcher: string): bigint {
  const s = searcher.toLowerCase();
  const now = Date.now();
  let total = 0n;
  for (const [k, h] of holds) {
    if (now - h.at > HOLD_TTL_MS) {
      holds.delete(k);
      continue;
    }
    if (h.searcher === s) total += h.wei;
  }
  return total;
}

/** Put `wei` on hold for this searcher against this opportunity (replaces an earlier hold on the same one). */
export function hold(searcher: string, opportunityId: string, wei: bigint): void {
  holds.set(`${searcher.toLowerCase()}:${opportunityId}`, { searcher: searcher.toLowerCase(), wei, at: Date.now() });
}

export function release(searcher: string, opportunityId: string): void {
  holds.delete(`${searcher.toLowerCase()}:${opportunityId}`);
}

/** The searcher's collateral we have not already spoken for; the cache is bypassed so a fresh deposit counts. */
export async function freeCollateral(searcher: string): Promise<bigint> {
  const c = await collateralOf(searcher);
  const h = heldBy(searcher);
  return c > h ? c - h : 0n;
}

/** Null when the bid is collectable; otherwise a human-readable rejection reason. */
export async function checkBond(searcher: string, bidWei: string, opportunityId?: string): Promise<string | null> {
  if (!SETTLEMENT) return null;
  if (!searcher?.startsWith("0x")) return "searcher must be an address when bonding is enabled";
  let needed: bigint;
  try {
    needed = BigInt(bidWei);
  } catch {
    return "invalid bidWei";
  }
  // A re-bid on the same opportunity replaces its own hold rather than stacking on it.
  const own = opportunityId ? holds.get(`${searcher.toLowerCase()}:${opportunityId}`)?.wei ?? 0n : 0n;
  const free = (await freeCollateral(searcher)) + own;
  if (free < needed) {
    const c = await collateralOf(searcher);
    return `insufficient collateral: ${c} wei bonded and free of withdrawals, ${heldBy(searcher) - own} wei already backing open bids, ${needed} wei bid — deposit into OrdoSettlement first`;
  }
  return null;
}
