/**
 * Cross-venue cycles, which is where this chain's arbitrage actually is.
 *
 * The house searcher used to price one shape: buy a token on one Uniswap V3
 * fee tier and sell it on another. Measured against the last two thousand
 * arbitrages on this chain, that shape is 11% of them and 1% of the profit.
 * 89% touch a Uniswap V4 pool, and the most common winning trade by a wide
 * margin is the simplest one there is — two pools, buy on one venue and sell
 * on the other.
 *
 * So: when the auction says a V4 pool moved, take the pair it moved, find the
 * V3 tiers that quote the same pair, and price the round trip both ways round.
 * Pricing goes through OrdoSwapV2 because V4 has no quoter on this chain, and
 * so does execution, because the same contract can walk a mixed V3/V4 route in
 * one transaction.
 */
import { WETH } from "@ordofi/core";
import { FEES, V3_FACTORY, ZERO_ADDRESS } from "@ordofi/core/arb";
import {
  NATIVE,
  type EthCall,
  type Leg,
  type PoolKey,
  otherSide,
  quoteRoute,
  v3Leg,
  v4Leg,
} from "@ordofi/core/ordoswap";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";

const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const low = (a: string): Hex => a.toLowerCase() as Hex;

/** A round trip out of ether and back, across two venues. */
export interface CrossCycle {
  legs: [Leg, Leg];
  /** For logs: which way round, and through what. */
  label: string;
  token: Hex;
}

/**
 * The V3 fee tiers that quote `token` against WETH.
 *
 * One call per tier and they all go at once; a pair with no V3 market answers
 * with the zero address on each and costs nothing further.
 */
export async function v3TiersFor(call: EthCall, token: Hex): Promise<number[]> {
  const [a, b] = low(token) < WETH ? [low(token), WETH as Hex] : [WETH as Hex, low(token)];
  const found = await Promise.all(
    FEES.map(async (fee) => {
      try {
        const raw = await call(V3_FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] }));
        const pool = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: raw }) as Hex;
        return low(pool) === ZERO_ADDRESS ? null : fee;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((f): f is number => f !== null);
}

/**
 * Every two-leg cycle between the V4 pool that moved and a V3 tier of the same
 * pair, in both directions.
 *
 * Both directions matter and only one of them can be profitable: a swap that
 * pushed the V4 price up leaves it dear there and cheap on V3, so the money is
 * in buying V3 and selling V4 — but the hint does not always carry the
 * direction, and quoting both costs two eth_calls against a contract that
 * answers for free.
 */
export function cyclesForV4(key: PoolKey, tiers: number[]): CrossCycle[] {
  const holdsEther = low(key.currency0) === NATIVE || low(key.currency1) === NATIVE;
  const a = holdsEther ? WETH : low(key.currency0);
  const token = otherSide(key, a as Hex, WETH as Hex);
  // Only ether-denominated cycles: the searcher bids in ether and is settled in
  // ether, so a pair that does not touch WETH is somebody else's trade.
  if (!holdsEther && low(key.currency0) !== WETH && low(key.currency1) !== WETH) return [];
  if (low(token) === WETH) return [];

  const out: CrossCycle[] = [];
  for (const fee of tiers) {
    out.push({
      legs: [v4Leg(key, WETH as Hex, WETH as Hex), v3Leg(token, WETH as Hex, fee)],
      label: `WETH >v4> ${token.slice(0, 8)} >v3:${fee}> WETH`,
      token,
    });
    out.push({
      legs: [v3Leg(WETH as Hex, token, fee), v4Leg(key, token, WETH as Hex)],
      label: `WETH >v3:${fee}> ${token.slice(0, 8)} >v4> WETH`,
      token,
    });
  }
  return out;
}

export interface Priced {
  cycle: CrossCycle;
  amountIn: bigint;
  amountOut: bigint;
  grossWei: bigint;
}

/**
 * Price every cycle at every size and keep the best, stopping at the deadline.
 *
 * The bid window is 200 ms and each quote is a round trip, so the order
 * matters: sizes are tried smallest first, and the loop checks the clock
 * between quotes rather than firing everything and sorting the wreckage.
 */
export async function priceCycles(
  call: EthCall,
  ordoSwap: Hex,
  cycles: CrossCycle[],
  sizes: bigint[],
  opts: { deadlineMs: number; from?: Hex; now?: () => number },
): Promise<Priced | null> {
  const now = opts.now ?? Date.now;
  const stopAt = now() + opts.deadlineMs;
  let best: Priced | null = null;
  for (const amountIn of sizes) {
    for (const cycle of cycles) {
      if (now() >= stopAt) return best;
      const amountOut = await quoteRoute(call, ordoSwap, cycle.legs, amountIn, opts.from);
      if (amountOut === null || amountOut <= amountIn) continue;
      const grossWei = amountOut - amountIn;
      if (!best || grossWei > best.grossWei) best = { cycle, amountIn, amountOut, grossWei };
    }
  }
  return best;
}
