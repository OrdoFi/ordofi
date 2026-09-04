/**
 * What a backrun is worth, decided in the 200 ms a bid window lasts.
 *
 * A swap moves one fee tier's price and leaves the pair's other tiers where
 * they were, so the backrun is the cross-tier round trip that closes the gap:
 * ETH in through one tier, out through another, ending in more ETH than it
 * started with. That is the whole strategy, and it is the honest one — it
 * takes value that is already sitting there rather than anything from the
 * person whose swap created it, and under VIA nine tenths of what it bids goes
 * back to them.
 *
 * The bid follows from the quote and nothing else. A fixed bid on everything,
 * which is what this bot did before, is not a market: it pays the operator's
 * own money out to users on rounds where nothing was captured, and it prices
 * a real opportunity the same as an empty one. When the round trip does not
 * clear gas and margin, the right bid is no bid, and most rounds will be that.
 *
 * Every lookup that can be cached is: within the window there is time for a
 * couple of quotes and nothing else.
 */
import { crossTierCycles, poolPair, poolTiers, quoteCycle, type Cycle, type EthCall } from "@ordofi/core/arb";
import type { Hex } from "viem";

export interface Sized {
  cycle: Cycle;
  amountIn: bigint;
  amountOut: bigint;
  /** amountOut - amountIn, before gas. */
  grossWei: bigint;
}

export interface Decision {
  /** The trade to submit as the backrun, or null when there is nothing worth doing. */
  best: Sized | null;
  /** What to bid: a share of the profit that survives gas. Zero means do not bid. */
  bidWei: bigint;
  reason: string;
}

export interface StrategyConfig {
  /** The token every cycle starts and ends in. */
  base: Hex;
  /** Cap per opportunity, whatever the quote says. */
  maxBidWei: bigint;
  /** Capital the bot can put into one round trip. */
  budgetWei: bigint;
  /** Gas the backrun is expected to cost, subtracted before anything is called profit. */
  gasCostWei: bigint;
  /** Profit below this is not worth a transaction. */
  minProfitWei: bigint;
  /**
   * Share of net profit offered as the bid, in percent. The rest is the
   * searcher's margin for the race it might lose; bidding all of it would mean
   * paying to break even.
   */
  bidSharePct: bigint;
}

/**
 * Sizes to quote. Price impact puts the optimum in the interior, and there is
 * only time for a couple of probes, so: a third of the budget and all of it.
 */
export function sizeLadder(budget: bigint): bigint[] {
  const sizes = [budget / 3n, budget].filter((s) => s > 0n);
  return [...new Set(sizes.map(String))].map(BigInt);
}

/**
 * The bid implied by a quote: what is left after gas, shared with the auction.
 * Never more than the cap, never more than the profit itself.
 */
export function bidFor(grossWei: bigint, cfg: StrategyConfig): bigint {
  const net = grossWei - cfg.gasCostWei;
  if (net < cfg.minProfitWei) return 0n;
  const offered = (net * cfg.bidSharePct) / 100n;
  return offered > cfg.maxBidWei ? cfg.maxBidWei : offered;
}

/** The best of the quotes that came back, by gross profit. */
export function pickBest(quotes: Sized[]): Sized | null {
  let best: Sized | null = null;
  for (const q of quotes) if (!best || q.grossWei > best.grossWei) best = q;
  return best && best.grossWei > 0n ? best : null;
}

/**
 * Which cycles a pool's token opens, cached: the factory lookups behind this
 * are four calls a pair and never change, and the bid window has no room for
 * them.
 */
export class CycleCache {
  private byPool = new Map<string, Cycle[]>();

  constructor(
    private readonly call: EthCall,
    private readonly base: Hex,
  ) {}

  async cyclesFor(pool: string): Promise<Cycle[]> {
    const key = pool.toLowerCase();
    const hit = this.byPool.get(key);
    if (hit) return hit;

    const pair = await poolPair(this.call, key as Hex);
    if (!pair) return this.remember(key, []);

    // The token that is not the base is the one a cycle goes out and back
    // through. A pool that does not touch the base at all is skipped: routing
    // it would need a second hop, and there is no time to find one.
    const base = this.base.toLowerCase();
    const token = pair.token0 === base ? pair.token1 : pair.token1 === base ? pair.token0 : null;
    if (!token) return this.remember(key, []);

    const tiers = await poolTiers(this.call, this.base, token as Hex);
    if (tiers.length < 2) return this.remember(key, []); // one tier: nowhere to close the gap
    return this.remember(key, crossTierCycles(token as Hex, this.base, tiers, token.slice(0, 8)));
  }

  private remember(key: string, cycles: Cycle[]): Cycle[] {
    this.byPool.set(key, cycles);
    return cycles;
  }

  get size(): number {
    return this.byPool.size;
  }
}

/**
 * Quote the cycles this opportunity opened and decide the bid.
 *
 * `deadline` is respected because a bid that arrives after the window closed
 * is worse than no bid: it is a quote paid for and thrown away, and on the
 * next opportunity the same lookups start again.
 */
export async function evaluate(
  call: EthCall,
  cycles: Cycle[],
  cfg: StrategyConfig,
  opts: { deadlineMs?: number } = {},
): Promise<Decision> {
  if (cycles.length === 0) return { best: null, bidWei: 0n, reason: "no cross-tier cycle for this pool" };
  if (cfg.budgetWei <= 0n) return { best: null, bidWei: 0n, reason: "no capital" };

  const deadline = opts.deadlineMs ?? Infinity;
  const started = Date.now();
  const sizes = sizeLadder(cfg.budgetWei);
  const quotes: Sized[] = [];

  for (const cycle of cycles) {
    if (Date.now() - started > deadline) break;
    const results = await Promise.all(sizes.map((amountIn) => quoteCycle(call, cycle, amountIn)));
    results.forEach((amountOut, i) => {
      if (amountOut === null) return;
      quotes.push({ cycle, amountIn: sizes[i], amountOut, grossWei: amountOut - sizes[i] });
    });
  }

  const best = pickBest(quotes);
  if (!best) return { best: null, bidWei: 0n, reason: "no round trip returned more than it cost" };

  const bidWei = bidFor(best.grossWei, cfg);
  if (bidWei === 0n) {
    return { best: null, bidWei: 0n, reason: `best edge ${best.grossWei} wei does not clear gas and margin` };
  }
  return { best, bidWei, reason: `${best.cycle.label} in ${best.amountIn} out ${best.amountOut}` };
}
