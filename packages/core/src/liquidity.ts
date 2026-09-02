/**
 * Uniswap V3 concentrated-liquidity arithmetic, and the ladder planner built
 * on it.
 *
 * A V3 position is a quantity of liquidity L between two ticks. How much of
 * each token that liquidity represents depends on where the current price sits
 * relative to the range: entirely below the range it is all token1, entirely
 * above it is all token0, inside it is a mix. Everything here is that one
 * relationship, in both directions, in exact integer arithmetic at Q64.96 so
 * the numbers we hand a wallet are the numbers the pool will accept.
 *
 * The planner turns a shape into rungs. A shape is a set of weights over the
 * bins of a range; the planner finds the single scale that spends the user's
 * budget without exceeding either token, and emits one rung per bin with the
 * amounts the pool will actually pull.
 */

export const Q96 = 2n ** 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

// ------------------------------------------------------------------ ticks

/** sqrt(1.0001^tick) * 2^96, exactly as TickMath does it. */
export function tickToSqrtPriceX96(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const abs = tick < 0 ? -tick : tick;
  let ratio = (abs & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => { ratio = (ratio * m) >> 128n; };
  if (abs & 0x2) mul(0xfff97272373d413259a46990580e213an);
  if (abs & 0x4) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (abs & 0x8) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (abs & 0x10) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (abs & 0x20) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (abs & 0x40) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (abs & 0x80) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (abs & 0x100) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (abs & 0x200) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (abs & 0x400) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (abs & 0x800) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (abs & 0x1000) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (abs & 0x2000) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (abs & 0x4000) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (abs & 0x8000) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (abs & 0x10000) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (abs & 0x20000) mul(0x5d6af8dedb81196699c329225ee604n);
  if (abs & 0x40000) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (abs & 0x80000) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // Round up from Q128.128 to Q64.96.
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

/** token1 per token0 (raw units) at a tick. */
export const tickToPrice = (tick: number): number => Math.pow(1.0001, tick);

/** The tick whose price is just at or below `price` (raw token1/token0). */
export function priceToTick(price: number): number {
  if (!(price > 0)) throw new Error("price must be positive");
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function alignTick(tick: number, spacing: number, dir: "down" | "up" | "nearest" = "nearest"): number {
  const q = tick / spacing;
  const n = dir === "down" ? Math.floor(q) : dir === "up" ? Math.ceil(q) : Math.round(q);
  return Math.max(MIN_TICK, Math.min(MAX_TICK, n * spacing));
}

// ---------------------------------------------------------------- amounts

const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;

/** Token amounts held by liquidity L in [sqrtA, sqrtB] when the price is sqrtP. */
export function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, L: bigint): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (L === 0n) return { amount0: 0n, amount1: 0n };
  if (sqrtP <= sqrtA) return { amount0: amount0For(sqrtA, sqrtB, L), amount1: 0n };
  if (sqrtP >= sqrtB) return { amount0: 0n, amount1: amount1For(sqrtA, sqrtB, L) };
  return { amount0: amount0For(sqrtP, sqrtB, L), amount1: amount1For(sqrtA, sqrtP, L) };
}

function amount0For(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  // L * (sqrtB - sqrtA) / (sqrtA * sqrtB) * Q96, rounded up as the pool does.
  const num = (L << 96n) * (sqrtB - sqrtA);
  const den = sqrtB * sqrtA;
  return (num + den - 1n) / den;
}

function amount1For(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  const num = L * (sqrtB - sqrtA);
  return (num + Q96 - 1n) / Q96;
}

/** The most liquidity `amount0` and `amount1` can fund in [sqrtA, sqrtB] at price sqrtP. */
export function liquidityForAmounts(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return liquidityFor0(sqrtA, sqrtB, amount0);
  if (sqrtP >= sqrtB) return liquidityFor1(sqrtA, sqrtB, amount1);
  const l0 = liquidityFor0(sqrtP, sqrtB, amount0);
  const l1 = liquidityFor1(sqrtA, sqrtP, amount1);
  return l0 < l1 ? l0 : l1;
}

function liquidityFor0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const intermediate = mulDiv(sqrtA, sqrtB, Q96);
  return mulDiv(amount0, intermediate, sqrtB - sqrtA);
}

function liquidityFor1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  return mulDiv(amount1, Q96, sqrtB - sqrtA);
}

// ---------------------------------------------------------------- planner

export type Shape = "spot" | "curve" | "bidask";

export interface PlanInput {
  /** Current pool tick and spacing. */
  tick: number;
  tickSpacing: number;
  /** Range, in ticks; will be aligned outward to the spacing. */
  minTick: number;
  maxTick: number;
  /** How many bins to cut the range into (clamped to what the spacing allows, max 40). */
  bins: number;
  shape: Shape;
  /** What the user is willing to spend, in raw units. Either may be zero. */
  budget0: bigint;
  budget1: bigint;
  /** Slippage tolerance on each rung's minimums, in basis points. */
  slippageBps?: number;
}

export interface Rung {
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  liquidity: bigint;
  weight: number;
}

export interface Plan {
  rungs: Rung[];
  total0: bigint;
  total1: bigint;
  minTick: number;
  maxTick: number;
  /** Which side actually binds the plan: the token that runs out first. */
  limitedBy: "token0" | "token1" | "none";
  /** True when the range sits entirely on one side of the price, so only one token is needed. */
  singleSided: 0 | 1 | null;
}

/**
 * Weights across bins for each shape, indexed from the low end of the range.
 *   spot    — even. Classic full-range-within-a-band.
 *   curve   — bell centred on the current price; most capital where trading is.
 *   bidask  — heaviest at the edges, lightest at the price; a ladder that
 *             converts as price walks away, and buys back as it returns.
 */
export function shapeWeights(shape: Shape, bins: number, centreFrac: number): number[] {
  const w: number[] = [];
  for (let i = 0; i < bins; i++) {
    const x = bins === 1 ? 0.5 : (i + 0.5) / bins; // bin centre in [0,1]
    const d = Math.abs(x - centreFrac); // distance from the price
    if (shape === "spot") w.push(1);
    else if (shape === "curve") w.push(Math.exp(-(d * d) / (2 * 0.22 * 0.22)));
    else w.push(0.15 + d * d * 4); // bidask
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

export function planLadder(input: PlanInput): Plan {
  const { tick, tickSpacing, shape } = input;
  if (tickSpacing <= 0) throw new Error("bad tick spacing");
  let minTick = alignTick(Math.min(input.minTick, input.maxTick), tickSpacing, "down");
  let maxTick = alignTick(Math.max(input.minTick, input.maxTick), tickSpacing, "up");
  if (maxTick <= minTick) maxTick = minTick + tickSpacing;

  const span = (maxTick - minTick) / tickSpacing;
  const bins = Math.max(1, Math.min(40, Math.min(Math.floor(input.bins), span)));
  const binTicks = Math.floor(span / bins) * tickSpacing;
  const sqrtP = tickToSqrtPriceX96(tick);

  // Where the price falls within the range, for the shape's centre.
  const centre = Math.min(1, Math.max(0, (tick - minTick) / (maxTick - minTick)));
  const weights = shapeWeights(shape, bins, centre);

  // For each bin, the tokens one unit of weight would need at this price.
  const UNIT = 10n ** 18n;
  const bounds: { lo: number; hi: number; a0: bigint; a1: bigint }[] = [];
  let need0 = 0n, need1 = 0n;
  for (let i = 0; i < bins; i++) {
    const lo = minTick + i * binTicks;
    const hi = i === bins - 1 ? maxTick : lo + binTicks;
    const L = BigInt(Math.round(weights[i] * 1e9)) * UNIT / 10n ** 9n;
    const a = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(lo), tickToSqrtPriceX96(hi), L);
    bounds.push({ lo, hi, a0: a.amount0, a1: a.amount1 });
    need0 += a.amount0;
    need1 += a.amount1;
  }

  // The scale is set by whichever token runs out first. A side the shape does
  // not need at all cannot bind, and a side the user has none of forces zero.
  let scaleNum = 0n, scaleDen = 1n, limitedBy: Plan["limitedBy"] = "none";
  const consider = (budget: bigint, need: bigint, side: "token0" | "token1") => {
    if (need === 0n) return;
    if (limitedBy === "none" || budget * scaleDen < scaleNum * need) { scaleNum = budget; scaleDen = need; limitedBy = side; }
  };
  consider(input.budget0, need0, "token0");
  consider(input.budget1, need1, "token1");

  const slip = BigInt(Math.max(0, Math.min(5000, Math.round(input.slippageBps ?? 100))));
  const build = (num: bigint, den: bigint) => {
    const rungs: Rung[] = [];
    let total0 = 0n, total1 = 0n;
    for (let i = 0; i < bins; i++) {
      const b = bounds[i];
      const L = limitedBy === "none" ? 0n : (BigInt(Math.round(weights[i] * 1e9)) * UNIT / 10n ** 9n) * num / den;
      if (L === 0n) continue;
      const a = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(b.lo), tickToSqrtPriceX96(b.hi), L);
      if (a.amount0 === 0n && a.amount1 === 0n) continue;
      rungs.push({
        tickLower: b.lo,
        tickUpper: b.hi,
        amount0: a.amount0,
        amount1: a.amount1,
        amount0Min: (a.amount0 * (10_000n - slip)) / 10_000n,
        amount1Min: (a.amount1 * (10_000n - slip)) / 10_000n,
        liquidity: L,
        weight: weights[i],
      });
      total0 += a.amount0;
      total1 += a.amount1;
    }
    return { rungs, total0, total1 };
  };

  // Each rung's amounts round up, so the sum can land a few wei over the
  // budget — which the contract would then fail to pull. Shave the scale
  // until it fits; a millionth per pass is far below what anyone can see.
  let built = build(scaleNum, scaleDen);
  const over = () => built.total0 > input.budget0 || built.total1 > input.budget1;
  for (let pass = 0; pass < 8 && over(); pass++) {
    scaleNum *= 999_999n;
    scaleDen *= 1_000_000n;
    built = build(scaleNum, scaleDen);
  }
  // Dust budgets: per-rung rounding alone can exceed a few wei. Halve until it
  // fits or there is nothing left to mint — an empty plan beats a failing one.
  for (let pass = 0; pass < 64 && over() && built.rungs.length; pass++) {
    scaleDen *= 2n;
    built = build(scaleNum, scaleDen);
  }
  const { rungs, total0, total1 } = built;

  const singleSided: Plan["singleSided"] = maxTick <= tick ? 1 : minTick > tick ? 0 : null;
  return { rungs, total0, total1, minTick, maxTick, limitedBy, singleSided };
}

// ------------------------------------------------- split allocation (Delta)

/**
 * The allocation Delta uses, reproduced exactly so a ladder built here comes
 * out the same as one built there for the same inputs.
 *
 * Instead of scaling both sides to whichever budget binds, each token's whole
 * budget is split across the bins that can hold it, in proportion to the
 * shape's weight: token0 across bins above the price, token1 across bins
 * below, and the bin containing the price takes a share of both. The pool
 * then takes what the current price allows and the rest is refunded in the
 * same transaction. It spends what the user typed, which is what people
 * expect a deposit form to do.
 *
 * Weights are linear, not gaussian: Curve is a tent peaked at the middle bin,
 * Bid-Ask a V with its floor at the bin holding the price. Both are clamped
 * at 0.02 so no bin is ever empty.
 */
export interface SplitRung {
  index: number;
  tickLower: number;
  tickUpper: number;
  side: "token0" | "token1" | "both";
  weight: number;
  amount0: bigint;
  amount1: bigint;
}

export function splitLadder(input: {
  tick: number;
  tickSpacing: number;
  minTick: number;
  maxTick: number;
  bins: number;
  shape: Shape;
  budget0: bigint;
  budget1: bigint;
}): SplitRung[] {
  const { tick, tickSpacing: sp, shape } = input;
  const lo = Math.round(Math.min(input.minTick, input.maxTick) / sp) * sp;
  const hi = Math.round(Math.max(input.minTick, input.maxTick) / sp) * sp;
  if (!(hi > lo)) return [];
  const spacings = Math.round((hi - lo) / sp);
  const n = Math.max(1, Math.min(Math.floor(input.bins) || 1, spacings));
  const rungs: SplitRung[] = [];
  for (let i = 0; i < n; i++) {
    const a = lo + Math.floor((spacings * i) / n) * sp;
    const b = lo + Math.floor((spacings * (i + 1)) / n) * sp;
    if (b <= a) continue;
    const side: SplitRung["side"] = tick >= b ? "token1" : tick < a ? "token0" : "both";
    rungs.push({ index: rungs.length, tickLower: a, tickUpper: b, side, weight: 0, amount0: 0n, amount1: 0n });
  }
  if (!rungs.length) return [];

  const mid = (rungs.length - 1) / 2;
  const bothIdx = rungs.findIndex((r) => r.side === "both");
  const anchor = bothIdx >= 0 ? bothIdx : tick >= rungs[rungs.length - 1].tickUpper ? rungs.length - 1 : 0;
  const reach = (x: number) => Math.max(x, rungs.length - 1 - x, 1);
  for (const r of rungs) {
    if (shape === "spot") r.weight = 1;
    else if (shape === "curve") r.weight = Math.max(0.02, 1 - Math.abs(r.index - mid) / (reach(mid) + 1));
    else r.weight = Math.max(0.02, Math.abs(r.index - anchor) / reach(anchor));
  }
  const share = (rs: SplitRung[], total: bigint, key: "amount0" | "amount1") => {
    if (!rs.length || total === 0n) return;
    const w = rs.map((r) => BigInt(Math.max(1, Math.round(r.weight * 1e6))));
    const sum = w.reduce((a, b) => a + b, 0n);
    let given = 0n;
    rs.forEach((r, i) => {
      const amt = i === rs.length - 1 ? total - given : (total * w[i]) / sum;
      r[key] = amt;
      given += amt;
    });
  };
  share(rungs.filter((r) => r.side !== "token1"), input.budget0, "amount0");
  share(rungs.filter((r) => r.side !== "token0"), input.budget1, "amount1");

  // A bin that straddles the price needs both tokens; with only one on offer
  // it would mint lopsided, so it is left out rather than minted wrong.
  return rungs.filter((r) => (r.amount0 > 0n || r.amount1 > 0n) && (r.side !== "both" || (r.amount0 > 0n && r.amount1 > 0n)));
}
