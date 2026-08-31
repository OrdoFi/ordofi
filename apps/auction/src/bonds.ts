import { createPublicClient, http, type Hex } from "viem";
import { ENDPOINTS, robinhoodChain } from "@ordofi/core";

/**
 * Bond gating. A bid is only worth accepting if the searcher has enough ETH
 * bonded in OrdoSettlement to actually pay it — otherwise settlement reverts
 * and the auction has sold something it can't collect on.
 *
 * Until ORDO_SETTLEMENT_ADDRESS is configured, gating is disabled and all bids
 * are accepted (Phase 1 behaviour, before the contract is deployed).
 */

const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS as Hex | undefined;
const CACHE_TTL_MS = Number(process.env.ORDO_BOND_CACHE_MS ?? 15_000);

const BOND_ABI = [
  {
    type: "function",
    name: "bond",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const client = createPublicClient({ chain: robinhoodChain, transport: http(ENDPOINTS.rpc) });
const cache = new Map<string, { value: bigint; at: number }>();

export function bondingEnabled(): boolean {
  return Boolean(SETTLEMENT);
}

export async function bondOf(searcher: string): Promise<bigint> {
  if (!SETTLEMENT) return 0n;
  const key = searcher.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const value = await client.readContract({
      address: SETTLEMENT,
      abi: BOND_ABI,
      functionName: "bond",
      args: [searcher as Hex],
    });
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch {
    return 0n;
  }
}

/** Null when the bid is collectable; otherwise a human-readable rejection reason. */
export async function checkBond(searcher: string, bidWei: string): Promise<string | null> {
  if (!SETTLEMENT) return null;
  if (!searcher?.startsWith("0x")) return "searcher must be an address when bonding is enabled";
  let needed: bigint;
  try {
    needed = BigInt(bidWei);
  } catch {
    return "invalid bidWei";
  }
  const held = await bondOf(searcher);
  if (held < needed) {
    return `insufficient bond: ${held} wei bonded, ${needed} wei bid — deposit into OrdoSettlement first`;
  }
  return null;
}
