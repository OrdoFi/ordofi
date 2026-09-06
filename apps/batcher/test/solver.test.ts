import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import {
  WETH,
  compositions,
  single,
  spread,
  acceptable,
  buyAmount,
  discoveryClearing,
  groupByPair,
  limitFailures,
  nettedA,
  nextClearing,
  residual,
  without,
} from "../src/solver.ts";
import type { Order, SimResult } from "../src/types.ts";

const ORDO: Hex = "0xfe2f0fb0c00d19786a8abf98d4b1f1ac8763b167";
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const who = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}` as Hex;

function order(owner: number, sell: Hex, buy: Hex, sellAmount: bigint, minBuy = 0n): Order {
  return { owner: who(owner), receiver: ZERO, sellToken: sell, buyToken: buy, sellAmount, minBuyAmount: minBuy, validTo: 2_000_000_000, nonce: BigInt(owner), appData: `0x${"0".repeat(64)}` as Hex };
}

test("both directions of a pair, and ether spelled as zero, land in one batch", () => {
  const a = order(1, WETH, ORDO, 10n ** 18n);
  const b = order(2, ORDO, ZERO, 500n * 10n ** 18n); // wants native ether back
  const [batch, ...rest] = groupByPair([a, b]);
  assert.equal(rest.length, 0);
  assert.equal(batch.a, WETH);
  assert.equal(batch.b, ORDO);
  assert.deepEqual(batch.sellA, [a]);
  assert.deepEqual(batch.sellB, [b]);
});

test("a perfect net has no residual and both sides are paid at the same rate", () => {
  const rate = 1000n; // ORDO per ETH
  const a = order(1, WETH, ORDO, 2n * 10n ** 18n);
  const b = order(2, ORDO, WETH, 2000n * 10n ** 18n);
  const [batch] = groupByPair([a, b]);
  const c = { pA: rate * 10n ** 18n, pB: 10n ** 18n };
  assert.equal(buyAmount(a, batch, c), 2000n * 10n ** 18n);
  assert.equal(buyAmount(b, batch, c), 2n * 10n ** 18n);
  assert.deepEqual(residual(batch, c), { a: 0n, b: 0n });
  assert.equal(nettedA(batch, c), 2n * 10n ** 18n, "all of the ether met a counterparty");
});

test("net demand for b: the residual is the a that b-sellers did not absorb", () => {
  const c = { pA: 1000n, pB: 1n };
  const a = order(1, WETH, ORDO, 10n * 10n ** 18n); // wants 10,000 ORDO
  const b = order(2, ORDO, WETH, 4000n * 10n ** 18n); // wants 4 ETH
  const [batch] = groupByPair([a, b]);
  const r = residual(batch, c);
  assert.equal(r.b, 0n);
  assert.equal(r.a, 6n * 10n ** 18n, "6 ETH go to the pool, 4 met bob");
  assert.equal(nettedA(batch, c), 4n * 10n ** 18n);
});

test("net demand for a: the residual is b", () => {
  const c = { pA: 1000n, pB: 1n };
  const a = order(1, WETH, ORDO, 1n * 10n ** 18n);
  const b = order(2, ORDO, WETH, 5000n * 10n ** 18n); // wants 5 ETH, only 1 offered
  const [batch] = groupByPair([a, b]);
  const r = residual(batch, c);
  assert.equal(r.a, 0n);
  assert.equal(r.b, 4000n * 10n ** 18n);
});

test("the price moves by exactly the ratio of held to owed, less the fee", () => {
  const a = order(1, WETH, ORDO, 1n * 10n ** 18n);
  const [batch] = groupByPair([a]);
  // First guess promised 1,000 ORDO; the pool gave 990.
  const c0 = { pA: 1000n * 10n ** 18n, pB: 10n ** 18n };
  const sim: SimResult = { tokens: [WETH, ORDO], delta: [0n, 990n * 10n ** 18n], owed: [0n, 1000n * 10n ** 18n], buyAmounts: [1000n * 10n ** 18n] };
  const c1 = nextClearing(batch, c0, sim, 10n, { a: 10n ** 18n, b: 0n });
  const promised = buyAmount(a, batch, c1);
  // 990 * (1 - 0.001) = 989.01
  assert.equal(promised, 989_010n * 10n ** 15n);
  assert.equal(c1.pB, c0.pB, "only the demanded token's price moves");
});

test("two-sided, net demand for a: the absorbed token is even, so the a-side price moves", () => {
  // alice sells 0.1 WETH; bob sells ORDO worth far more. The residual ORDO is
  // sold for WETH; the WETH side came back short of what bob is owed.
  const a = order(1, WETH, ORDO, 10n ** 17n);
  const b = order(2, ORDO, WETH, 3211n * 10n ** 18n);
  const [batch] = groupByPair([a, b]);
  const c0 = { pA: 528n * 10n ** 18n, pB: 10n ** 17n }; // 5280 ORDO per WETH
  const owedA = buyAmount(b, batch, c0); // ≈ 0.608 WETH
  const owedB = buyAmount(a, batch, c0); // 528 ORDO
  const sim: SimResult = {
    tokens: [WETH, ORDO],
    delta: [10n ** 17n + 49n * 10n ** 16n, owedB], // 0.1 kept + 0.49 from the pool; ORDO exactly even
    owed: [owedA, owedB],
    buyAmounts: [owedB, owedA],
  };
  const c1 = nextClearing(batch, c0, sim, 10n, { a: 0n, b: 3211n * 10n ** 18n - owedB });
  assert.equal(c1.pA, c0.pA, "ORDO is even; its price stands");
  assert.notEqual(c1.pB, c0.pB, "WETH is short; bob's rate is what moves");
  const owedA1 = buyAmount(b, batch, c1);
  const want = (sim.delta[0] * 9_990n) / 10_000n;
  assert.ok(owedA1 <= want && want - owedA1 < 100n, `bob is owed what is held less the fee (${owedA1} vs ${want}), rounded down`);
  assert.ok(buyAmount(a, batch, c1) > owedB, "and alice gets more ORDO per WETH, the same uniform rate from the other side");
});

test("a clean one-sided fill still pays the fee: held equals owed, the residual says which side the AMM fed", () => {
  const a = order(1, WETH, ORDO, 10n ** 18n);
  const [batch] = groupByPair([a]);
  const out = 990n * 10n ** 18n;
  const c0 = { pA: out, pB: 10n ** 18n }; // discovery: promise exactly the AMM output
  const sim: SimResult = { tokens: [WETH, ORDO], delta: [0n, out], owed: [0n, out], buyAmounts: [out] };
  const c1 = nextClearing(batch, c0, sim, 10n, { a: 10n ** 18n, b: 0n });
  assert.equal(buyAmount(a, batch, c1), (out * 9_990n) / 10_000n, "10 bps shaved off the promise");
});

test("acceptable: short means no; fee above the cap means no; inside means yes", () => {
  const a = order(1, WETH, ORDO, 1n * 10n ** 18n);
  const [batch] = groupByPair([a]);
  const owed = 1000n * 10n ** 18n;
  const short: SimResult = { tokens: [WETH, ORDO], delta: [0n, owed - 1n], owed: [0n, owed], buyAmounts: [owed] };
  assert.equal(acceptable(batch, short, 30n).ok, false);
  const greedy: SimResult = { tokens: [WETH, ORDO], delta: [0n, owed + owed / 20n], owed: [0n, owed], buyAmounts: [owed] };
  assert.equal(acceptable(batch, greedy, 30n).ok, false, "5% kept is above a 0.3% cap");
  const fine: SimResult = { tokens: [WETH, ORDO], delta: [0n, owed + owed / 1000n], owed: [0n, owed], buyAmounts: [owed] };
  assert.equal(acceptable(batch, fine, 30n).ok, true);
});

test("orders the price cannot reach are named, and the batch goes on without them", () => {
  const c = { pA: 1000n, pB: 1n };
  const ok = order(1, WETH, ORDO, 10n ** 18n, 900n * 10n ** 18n);
  const greedy = order(2, WETH, ORDO, 10n ** 18n, 1100n * 10n ** 18n);
  const [batch] = groupByPair([ok, greedy]);
  assert.deepEqual(limitFailures(batch, c), [greedy]);
  const rest = without(batch, [greedy]);
  assert.deepEqual(rest.sellA, [ok]);
  assert.equal(limitFailures(rest, c).length, 0);
});

test("discovery takes the a-side rate when there is one, the b-side otherwise", () => {
  const a = order(1, WETH, ORDO, 2n * 10n ** 18n);
  const [ab] = groupByPair([a]);
  assert.deepEqual(discoveryClearing(ab, 1800n * 10n ** 18n, 0n), { pA: 1800n * 10n ** 18n, pB: 2n * 10n ** 18n });
  const b = order(2, ORDO, WETH, 3000n * 10n ** 18n);
  const [bb] = groupByPair([b]);
  assert.deepEqual(discoveryClearing(bb, 0n, 3n * 10n ** 18n), { pA: 3000n * 10n ** 18n, pB: 3n * 10n ** 18n });
  assert.equal(discoveryClearing(bb, 0n, 0n), null, "a pool that returns nothing is not a price");
});

test("compositions enumerate every split of the grid across the routes", () => {

  assert.deepEqual(compositions(1, 4n), [[4n]]);
  assert.equal(compositions(2, 4n).length, 5, "0/4 … 4/0");
  assert.equal(compositions(3, 4n).length, 15);
  for (const c of compositions(3, 8n)) assert.equal(c.reduce((a, b) => a + b, 0n), 8n, "each split uses the whole amount");
  const legs = (i: number) => [{ venue: 1, path: "0x" as const, key: { currency0: ZERO, currency1: ORDO, fee: i, tickSpacing: 1, hooks: ZERO }, zeroForOne: true }];
  const alloc = { parts: [{ legs: legs(1), num: 3n }, { legs: legs(2), num: 0n }, { legs: legs(3), num: 1n }], den: 4n };
  const xs = spread(1001n, alloc);
  assert.equal(xs.length, 2, "a zero part sends nothing");
  assert.equal(xs[0].amountIn + xs[1].amountIn, 1001n, "dust lands in the last part, nothing is lost");
  assert.equal(xs[0].amountIn, 750n);
  assert.deepEqual(spread(10n, single(legs(1))), [{ legs: legs(1), amountIn: 10n }]);
});
