/**
 * Pricing and executing a route that crosses venues, through OrdoSwapV2.
 *
 * This chain has no Uniswap V4 quoter. The only way to learn what a V4 pool
 * will pay is to run the swap and look at the answer, which is what
 * `OrdoSwapV2.quote` does: it performs the route and then reverts with the
 * result, so an eth_call prices it for nothing. The gateway has done this for
 * user swaps since Ordo Swap shipped; the searcher needs the same thing to bid
 * on a V4 opportunity, so the venue-agnostic parts live here rather than twice.
 *
 * Why it matters that the searcher can do this at all: 89% of the arbitrage on
 * this chain touches a V4 pool and 99% of the profit does, and the house bot
 * could only price V3 cross-tier cycles. A marketplace whose only bidder
 * cannot see the goods clears at nothing, which is what ours has been doing.
 */
import { decodeErrorResult, encodeFunctionData, encodePacked, parseAbi, type Hex } from "viem";

export const ORDO_SWAP2_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Leg { uint8 venue; bytes path; PoolKey key; bool zeroForOne; }",
  "struct Reclaim { Leg[] legs; uint256 amountIn; uint256 minProfit; uint256 gas; }",
  "function swap(Leg[] legs, uint256 amountIn, uint256 amountOutMinimum, address recipient, bool nativeOut, Reclaim reclaim) payable returns (uint256 amountOut, uint256 surplus)",
  "function quote(Leg[] legs, uint256 amountIn, Reclaim reclaim) payable",
  "error QuoteResult(uint256 amountOut, uint256 reclaimProfit, bytes reclaimFailure)",
]);

export const NATIVE: Hex = "0x0000000000000000000000000000000000000000";

export interface PoolKey {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

export interface Leg {
  /** 0 = Uniswap V3, 1 = Uniswap V4. */
  venue: number;
  /** Packed V3 path; empty for V4. */
  path: Hex;
  key: PoolKey;
  zeroForOne: boolean;
}

export const EMPTY_KEY: PoolKey = { currency0: NATIVE, currency1: NATIVE, fee: 0, tickSpacing: 0, hooks: NATIVE };
/** No reclaim: a searcher's cycle is the whole trade, not a swap with a back-run bolted on. */
export const NO_RECLAIM = { legs: [] as Leg[], amountIn: 0n, minProfit: 0n, gas: 0n };

const low = (a: string): Hex => a.toLowerCase() as Hex;

export function v3Leg(tokenIn: Hex, tokenOut: Hex, fee: number): Leg {
  return {
    venue: 0,
    path: encodePacked(["address", "uint24", "address"], [low(tokenIn), fee, low(tokenOut)]),
    key: EMPTY_KEY,
    zeroForOne: false,
  };
}

/**
 * A V4 leg. `tokenIn` is named as an ERC-20; a pool that holds ether spells it
 * as address zero, so the direction is decided against the key's own currencies
 * rather than against the token the caller named.
 */
export function v4Leg(key: PoolKey, tokenIn: Hex, weth: Hex): Leg {
  const holdsEther = low(key.currency0) === NATIVE || low(key.currency1) === NATIVE;
  const cIn = holdsEther && low(tokenIn) === low(weth) ? NATIVE : low(tokenIn);
  return { venue: 1, path: "0x", key, zeroForOne: low(key.currency0) === cIn };
}

/** The other side of a V4 pool from `token`, named as an ERC-20 rather than as ether. */
export function otherSide(key: PoolKey, token: Hex, weth: Hex): Hex {
  const a = low(key.currency0) === NATIVE ? low(weth) : low(key.currency0);
  const b = low(key.currency1) === NATIVE ? low(weth) : low(key.currency1);
  return a === low(token) ? b : a;
}

export type EthCall = (to: Hex, data: Hex, opts?: { value?: bigint; from?: Hex }) => Promise<Hex>;

/**
 * What a route returns for `amountIn`, or null if it cannot be priced.
 *
 * `quote` always reverts — with the answer on success, with something else on
 * failure — so a plain call is expected to throw and the revert payload is the
 * result. A route that reverts for any other reason is simply not quotable and
 * is skipped; there is nothing to bid on either way.
 */
export async function quoteRoute(
  call: EthCall,
  ordoSwap: Hex,
  legs: Leg[],
  amountIn: bigint,
  from?: Hex,
): Promise<bigint | null> {
  const data = encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "quote", args: [legs, amountIn, NO_RECLAIM] });
  try {
    await call(ordoSwap, data, { value: amountIn, from });
    return null; // quote() is supposed to revert; a clean return means it did not run
  } catch (e) {
    const bytes = revertBytes(e);
    if (!bytes) return null;
    const decoded = decodeQuoteResult(bytes);
    return decoded ? decoded.amountOut : null;
  }
}

export function decodeQuoteResult(revertData: Hex): { amountOut: bigint; profit: bigint } | null {
  try {
    const d = decodeErrorResult({ abi: ORDO_SWAP2_ABI, data: revertData });
    if (d.errorName !== "QuoteResult") return null;
    const [amountOut, profit] = d.args as [bigint, bigint, Hex];
    return { amountOut, profit };
  } catch {
    return null;
  }
}

/** Providers bury the revert payload in different places; look in all of them. */
export function revertBytes(err: unknown): Hex | null {
  const e = err as { data?: unknown; message?: string };
  for (const c of [e?.data, (e?.data as { data?: unknown })?.data]) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c as Hex;
  }
  const m = /(0x[0-9a-fA-F]{8,})/.exec(e?.message ?? "");
  return m ? (m[1] as Hex) : null;
}

/**
 * Calldata for the cycle itself. Ether in and ether out: the searcher bids in
 * ether and is measured in ether, and `amountOutMinimum` is what makes a lost
 * race revert rather than fill at a loss.
 */
export function cycleCalldata(legs: Leg[], amountIn: bigint, minOut: bigint, recipient: Hex): Hex {
  return encodeFunctionData({
    abi: ORDO_SWAP2_ABI,
    functionName: "swap",
    args: [legs, amountIn, minOut, recipient, true, NO_RECLAIM],
  });
}
