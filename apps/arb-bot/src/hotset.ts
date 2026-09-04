import type { Hex } from "viem";

/**
 * Which tokens are worth quoting, decided by the chain rather than by a list.
 *
 * The trade API knows about ~9,000 tokens. Discovering pools for all of them is
 * two factory calls each, which does not finish between re-discoveries, so the
 * bot spent days quoting whichever token happened to be first in the map. It is
 * also the wrong question: arbitrage does not appear where tokens exist, it
 * appears where trading is heavy enough to push two fee tiers apart.
 *
 * So: read the recent Swap logs, count how busy each pool was, resolve pools to
 * their pairs, and rank the tokens by the volume of swaps they took part in.
 * The top of that ranking is where a cross-tier dislocation can open at all.
 * One eth_getLogs and a handful of cached pool lookups, repeated occasionally.
 */

/** Uniswap V3 `Swap(address,address,int256,int256,uint160,uint128,int24)`. */
export const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";

export interface SwapLog {
  address: string;
}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * A pool's pair, remembered for the life of the process. A pool's tokens never
 * change, and the same few hundred pools come back on every refresh.
 */
export class PoolBook {
  private pairs = new Map<string, [Hex, Hex]>();
  private misses = new Set<string>();

  constructor(private readonly call: (to: string, data: string) => Promise<string>) {}

  known(pool: string): [Hex, Hex] | undefined {
    return this.pairs.get(pool.toLowerCase());
  }

  /** Resolve pools we have not seen, `concurrency` at a time. Failures are not retried. */
  async learn(pools: readonly string[], concurrency = 8): Promise<void> {
    const todo = [...new Set(pools.map((p) => p.toLowerCase()))].filter((p) => !this.pairs.has(p) && !this.misses.has(p));
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
        while (i < todo.length) {
          const pool = todo[i++];
          try {
            const [t0, t1] = await Promise.all([this.call(pool, TOKEN0_SELECTOR), this.call(pool, TOKEN1_SELECTOR)]);
            this.pairs.set(pool, [`0x${t0.slice(26)}` as Hex, `0x${t1.slice(26)}` as Hex]);
          } catch {
            this.misses.add(pool);
          }
        }
      }),
    );
  }

  get size(): number {
    return this.pairs.size;
  }
}

/**
 * Rank the tokens appearing in `logs` by how many swaps they were part of,
 * heaviest first, dropping `exclude` (WETH: it is one side of every cycle
 * already, never a mid).
 */
export function rankTokens(logs: readonly SwapLog[], book: PoolBook, exclude: readonly string[]): { address: Hex; swaps: number }[] {
  const drop = new Set(exclude.map((a) => a.toLowerCase()));
  const hits = new Map<string, number>();
  for (const l of logs) {
    const pair = book.known(l.address);
    if (!pair) continue;
    for (const t of pair) {
      const k = t.toLowerCase();
      if (drop.has(k)) continue;
      hits.set(k, (hits.get(k) ?? 0) + 1);
    }
  }
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([address, swaps]) => ({ address: address as Hex, swaps }));
}

export interface HotSetOptions {
  /** How far back to look. At 100 ms blocks, 3,000 blocks is about five minutes. */
  lookbackBlocks?: number;
  /** Most tokens to return. Each one costs a handful of factory calls in discovery. */
  limit?: number;
  /** Never a mid, because every cycle already starts and ends there. */
  weth: Hex;
}

/**
 * The busiest tokens of the last few minutes, heaviest first.
 *
 * Throws if the logs cannot be read; the caller decides whether to fall back to
 * the previous set (which is the right move — a stale hot set beats no set).
 */
export async function hotMids(rpc: Rpc, book: PoolBook, opts: HotSetOptions): Promise<{ address: Hex; swaps: number }[]> {
  const lookback = opts.lookbackBlocks ?? 3_000;
  const limit = opts.limit ?? 24;
  const head = Number(await rpc("eth_blockNumber", []));
  const from = Math.max(0, head - lookback);
  const logs = (await rpc("eth_getLogs", [
    { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}`, topics: [SWAP_TOPIC] },
  ])) as SwapLog[];
  await book.learn(logs.map((l) => l.address));
  return rankTokens(logs, book, [opts.weth]).slice(0, limit);
}
