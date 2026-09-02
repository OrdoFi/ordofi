import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TICK,
  MIN_TICK,
  Q96,
  alignTick,
  amountsForLiquidity,
  liquidityForAmounts,
  planLadder,
  priceToTick,
  shapeWeights,
  tickToSqrtPriceX96,
} from "../src/liquidity.ts";

test("tickToSqrtPriceX96 matches TickMath at the reference points", () => {
  assert.equal(tickToSqrtPriceX96(0), Q96);
  assert.equal(tickToSqrtPriceX96(MIN_TICK), 4295128739n);
  assert.equal(tickToSqrtPriceX96(MAX_TICK), 1461446703485210103287273052203988822378723970342n);
  // The live WETH/USDG pool: slot0 sqrtPrice must sit between its tick and the next.
  const live = 3868865839818931817731225n;
  assert.ok(tickToSqrtPriceX96(-198553) <= live && live < tickToSqrtPriceX96(-198552));
});

test("price and tick round-trip", () => {
  for (const t of [-200000, -1234, 0, 777, 150000]) {
    const p = Math.pow(1.0001, t);
    assert.equal(priceToTick(p * 1.00001), t);
  }
  assert.equal(alignTick(-198553, 10, "down"), -198560);
  assert.equal(alignTick(-198553, 10, "up"), -198550);
  assert.equal(alignTick(-198553, 1), -198553);
});

test("amounts and liquidity invert each other", () => {
  const tick = -198553;
  const sqrtP = tickToSqrtPriceX96(tick);
  const a = tickToSqrtPriceX96(tick - 100), b = tickToSqrtPriceX96(tick + 100);
  const L = 10n ** 18n;
  const { amount0, amount1 } = amountsForLiquidity(sqrtP, a, b, L);
  assert.ok(amount0 > 0n && amount1 > 0n, "in-range holds both");
  const back = liquidityForAmounts(sqrtP, a, b, amount0, amount1);
  // Rounding up on amounts means we can fund at least L, never less.
  assert.ok(back >= L && back - L < 1_000_000n, `round trip ${back} vs ${L}`);

  // Entirely above the price: token0 only. Entirely below: token1 only.
  const above = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(tick + 10), tickToSqrtPriceX96(tick + 50), L);
  assert.ok(above.amount0 > 0n && above.amount1 === 0n);
  const below = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(tick - 50), tickToSqrtPriceX96(tick - 10), L);
  assert.ok(below.amount0 === 0n && below.amount1 > 0n);
});

test("shapes weigh where they say they do", () => {
  const spot = shapeWeights("spot", 5, 0.5);
  assert.ok(spot.every((w) => Math.abs(w - 0.2) < 1e-9));
  const curve = shapeWeights("curve", 5, 0.5);
  assert.ok(curve[2] > curve[0] && curve[2] > curve[4], "curve peaks at the price");
  const bidask = shapeWeights("bidask", 5, 0.5);
  assert.ok(bidask[0] > bidask[2] && bidask[4] > bidask[2], "bid-ask is heaviest at the edges");
  for (const w of [spot, curve, bidask]) assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

const POOL = { tick: -198553, tickSpacing: 1 };

test("a two-sided plan spends up to the binding budget and never over either", () => {
  const plan = planLadder({ ...POOL, minTick: POOL.tick - 200, maxTick: POOL.tick + 200, bins: 8, shape: "spot", budget0: 10n ** 18n, budget1: 5_000_000_000n });
  assert.equal(plan.rungs.length, 8);
  assert.ok(plan.total0 <= 10n ** 18n && plan.total1 <= 5_000_000_000n, "never exceeds a budget");
  // And a plan is never over budget on the side it is limited by, even by a wei.
  for (const b1 of [1_000_000_000n, 999_999_999n, 123_456_789n, 7n]) {
    const q = planLadder({ ...POOL, minTick: POOL.tick - 300, maxTick: POOL.tick - 10, bins: 7, shape: "curve", budget0: 0n, budget1: b1 });
    assert.ok(q.total1 <= b1, `budget ${b1} overshot to ${q.total1}`);
  }
  assert.ok(plan.total0 === 10n ** 18n || plan.total1 === 5_000_000_000n || plan.total0 > 10n ** 18n * 999n / 1000n || plan.total1 > 5_000_000_000n * 999n / 1000n, "spends the binding side");
  assert.equal(plan.singleSided, null);
  // Rungs tile the range without gaps or overlap, aligned to spacing.
  for (let i = 0; i < plan.rungs.length; i++) {
    const r = plan.rungs[i];
    assert.ok(r.tickUpper > r.tickLower);
    if (i > 0) assert.equal(r.tickLower, plan.rungs[i - 1].tickUpper);
    assert.ok(r.amount0Min <= r.amount0 && r.amount1Min <= r.amount1);
  }
  assert.equal(plan.rungs[0].tickLower, plan.minTick);
  assert.equal(plan.rungs.at(-1)!.tickUpper, plan.maxTick);
});

test("a range entirely above the price needs only token0", () => {
  const plan = planLadder({ ...POOL, minTick: POOL.tick + 10, maxTick: POOL.tick + 300, bins: 5, shape: "bidask", budget0: 2n * 10n ** 18n, budget1: 0n });
  assert.equal(plan.singleSided, 0);
  assert.equal(plan.total1, 0n);
  assert.ok(plan.total0 > 0n && plan.total0 <= 2n * 10n ** 18n);
  assert.equal(plan.limitedBy, "token0");
  assert.equal(plan.rungs.length, 5);
});

test("a range entirely below the price needs only token1", () => {
  const plan = planLadder({ ...POOL, minTick: POOL.tick - 300, maxTick: POOL.tick - 10, bins: 5, shape: "curve", budget0: 0n, budget1: 1_000_000_000n });
  assert.equal(plan.singleSided, 1);
  assert.equal(plan.total0, 0n);
  assert.ok(plan.total1 > 0n && plan.total1 <= 1_000_000_000n);
});

test("no budget on a side the range needs yields an empty plan, not a wrong one", () => {
  const plan = planLadder({ ...POOL, minTick: POOL.tick - 100, maxTick: POOL.tick + 100, bins: 4, shape: "spot", budget0: 10n ** 18n, budget1: 0n });
  // token1 is needed below the price and there is none: token1 binds at zero.
  assert.equal(plan.limitedBy, "token1");
  assert.equal(plan.rungs.length, 0);
  assert.equal(plan.total0, 0n);
});

test("bins are clamped to what the spacing allows and to 40", () => {
  const coarse = planLadder({ tick: -198553, tickSpacing: 60, minTick: -198600, maxTick: -198480, bins: 20, shape: "spot", budget0: 10n ** 18n, budget1: 10n ** 9n });
  assert.ok(coarse.rungs.length <= 2, `spacing 60 over 120 ticks is at most 2 bins, got ${coarse.rungs.length}`);
  for (const r of coarse.rungs) { assert.ok(r.tickLower % 60 === 0); assert.ok(r.tickUpper % 60 === 0); }
  const many = planLadder({ ...POOL, minTick: POOL.tick - 500, maxTick: POOL.tick + 500, bins: 100, shape: "spot", budget0: 10n ** 18n, budget1: 10n ** 10n });
  assert.ok(many.rungs.length <= 40);
});

import { splitLadder } from "../src/liquidity.ts";

test("split allocation spends each token across the bins that can hold it", () => {
  const rs = splitLadder({ tick: -198553, tickSpacing: 1, minTick: -198753, maxTick: -198353, bins: 8, shape: "spot", budget0: 10n ** 18n, budget1: 5_000_000n });
  const sum0 = rs.reduce((n, r) => n + r.amount0, 0n), sum1 = rs.reduce((n, r) => n + r.amount1, 0n);
  assert.equal(sum0, 10n ** 18n, "all of token0 is placed");
  assert.equal(sum1, 5_000_000n, "all of token1 is placed");
  for (const r of rs) {
    if (r.side === "token0") assert.equal(r.amount1, 0n);
    if (r.side === "token1") assert.equal(r.amount0, 0n);
    if (r.side === "both") assert.ok(r.amount0 > 0n && r.amount1 > 0n);
  }
  assert.equal(rs.filter((r) => r.side === "both").length, 1);
});

test("split shapes: tent for curve, V for bid-ask, floor at 0.02", () => {
  const base = { tick: -198553, tickSpacing: 1, minTick: -198753, maxTick: -198353, bins: 9, budget0: 10n ** 18n, budget1: 10n ** 9n };
  const curve = splitLadder({ ...base, shape: "curve" });
  assert.ok(curve[4].weight === 1 && curve[0].weight < curve[4].weight && curve[8].weight < curve[4].weight);
  const bidask = splitLadder({ ...base, shape: "bidask" });
  const both = bidask.find((r) => r.side === "both")!;
  assert.equal(both.weight, 0.02, "the price bin is the floor of the V");
  assert.ok(bidask[0].weight === 1 || bidask[bidask.length - 1].weight === 1, "an edge carries full weight");
});

test("split drops the straddling bin when only one token is offered", () => {
  const rs = splitLadder({ tick: -198553, tickSpacing: 1, minTick: -198753, maxTick: -198353, bins: 8, shape: "spot", budget0: 10n ** 18n, budget1: 0n });
  assert.ok(rs.every((r) => r.side === "token0"), "only above-price bins remain");
  // The price bin took its share before being dropped, exactly as Delta does,
  // so slightly less than the budget is placed and the rest is never pulled.
  const placed = rs.reduce((n, r) => n + r.amount0, 0n);
  assert.ok(placed < 10n ** 18n && placed >= (10n ** 18n * 5n) / 10n, `placed ${placed}`);
});

test("split bins are cut on spacing boundaries and never exceed the spacings available", () => {
  const rs = splitLadder({ tick: -198553, tickSpacing: 60, minTick: -198780, maxTick: -198480, bins: 40, shape: "spot", budget0: 1n, budget1: 1n });
  assert.ok(rs.length <= 5);
  for (const r of rs) { assert.ok(r.tickLower % 60 === 0 && r.tickUpper % 60 === 0); }
});
