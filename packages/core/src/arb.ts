/**
 * The V3 arithmetic two OrdoFi bots both need: which fee tiers a pair has,
 * what a round trip through them returns, and the calldata that executes it.
 *
 * The house arbitrage bot (`apps/arb-bot`) scans for these on a timer. The
 * searcher bot (`apps/searcher-bot`) evaluates one on demand, in the 200 ms a
 * bid window lasts, because the auction just told it which pool moved. Same
 * chain, same router, same maths — so it lives here rather than twice.
 *
 * Everything takes an `EthCall` rather than reaching for a transport, which
 * keeps it testable and lets each bot keep its own upstream policy.
 */
import { decodeFunctionResult, encodeFunctionData, encodePacked, type Hex } from "viem";
import { encodeExactInputSwap } from "./router.js";

export const V3_FACTORY: Hex = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
export const QUOTER_V2: Hex = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The fee tiers this chain's factory was deployed with. */
export const FEES: number[] = [100, 500, 3000, 10000];

export type EthCall = (to: string, data: Hex) => Promise<Hex>;

const FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes" }, { type: "uint256" }],
    outputs: [{ type: "uint256", name: "amountOut" }, { type: "uint160[]" }, { type: "uint32[]" }, { type: "uint256" }],
  },
] as const;

const POOL_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

/** A closed route: starts and ends in the same token, one fee per hop. */
export interface Cycle {
  label: string;
  /** tokens.length === fees.length + 1, first and last equal. */
  tokens: Hex[];
  fees: number[];
}

/** Uniswap V3's packed path: token, fee, token, fee, … , token. */
export function encodePath(tokens: Hex[], fees: number[]): Hex {
  const types: string[] = [];
  const values: (Hex | number)[] = [];
  tokens.forEach((t, i) => {
    types.push("address");
    values.push(t);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  });
  return encodePacked(types as never, values as never);
}

/** Which of the four tiers actually have a pool for this pair. */
export async function poolTiers(call: EthCall, a: Hex, b: Hex): Promise<number[]> {
  const hits = await Promise.all(
    FEES.map(async (fee) => {
      try {
        const out = await call(V3_FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] }));
        const pool = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: out }) as string;
        return pool.toLowerCase() !== ZERO_ADDRESS ? fee : null;
      } catch {
        return null; // no pool at this tier
      }
    }),
  );
  return hits.filter((f): f is number => f !== null);
}

/** What a pool trades and at what fee. Null when the address is not a V3 pool. */
export async function poolPair(call: EthCall, pool: Hex): Promise<{ token0: Hex; token1: Hex; fee: number } | null> {
  try {
    const read = async (functionName: "token0" | "token1" | "fee") => {
      const out = await call(pool, encodeFunctionData({ abi: POOL_ABI, functionName }));
      return decodeFunctionResult({ abi: POOL_ABI, functionName, data: out });
    };
    const [token0, token1, fee] = await Promise.all([read("token0"), read("token1"), read("fee")]);
    return {
      token0: (token0 as string).toLowerCase() as Hex,
      token1: (token1 as string).toLowerCase() as Hex,
      fee: Number(fee),
    };
  } catch {
    return null;
  }
}

/** What the path returns for this input, or null when nothing can be routed along it now. */
export async function quotePath(call: EthCall, path: Hex, amountIn: bigint): Promise<bigint | null> {
  try {
    const out = await call(QUOTER_V2, encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInput", args: [path, amountIn] }));
    const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInput", data: out }) as [
      bigint,
      bigint[],
      number[],
      bigint,
    ];
    return amountOut;
  } catch {
    return null; // no liquidity along this path right now
  }
}

export function quoteCycle(call: EthCall, c: Cycle, amountIn: bigint): Promise<bigint | null> {
  return quotePath(call, encodePath(c.tokens, c.fees), amountIn);
}

/**
 * The round trip as one atomic SwapRouter02 call, returning native ETH.
 *
 * `minReturn` is the whole safety property: the swap reverts rather than
 * completing at a loss, so a cycle whose edge evaporated between the quote and
 * inclusion — the usual outcome on a fast chain — costs gas and nothing else.
 */
export function buildCycleSwap(c: Cycle, amountIn: bigint, minReturn: bigint, deadlineSeconds = 60): Hex {
  return encodeExactInputSwap({
    path: encodePath(c.tokens, c.fees),
    amountIn,
    amountOutMinimum: minReturn,
    nativeOut: true,
    deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds),
  });
}

/**
 * The cross-tier cycles for one token: in through one fee tier, out through
 * another. These are the cycles a swap on that token opens — it moves one
 * tier's price and leaves the others where they were.
 */
export function crossTierCycles(token: Hex, base: Hex, tiers: number[], label = token.slice(0, 8)): Cycle[] {
  const cycles: Cycle[] = [];
  for (const fA of tiers) {
    for (const fB of tiers) {
      if (fA !== fB) cycles.push({ label: `${label} ${fA}/${fB}`, tokens: [base, token, base], fees: [fA, fB] });
    }
  }
  return cycles;
}
