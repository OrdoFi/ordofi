/**
 * The netting solver for one pair.
 *
 * A batch on pair (A, B) has sellers of A (who want B) and sellers of B (who
 * want A). The contract pays every order at one price per token, so the whole
 * batch is one number: how much B one unit of A is worth, written as the
 * fraction pA/pB. Sellers of A get `sell * pA / pB`; sellers of B get
 * `sell * pB / pA`.
 *
 * Whatever the two sides do not cover for each other is the residual, and the
 * residual is the only thing that touches the AMM. The price the batch clears
 * at is the price the AMM gives *the residual*, which is better than the price
 * it would give either side alone — that is the whole product.
 *
 * The solver does not model the AMM. `OrdoBatch.simulate` runs the real thing
 * and reverts with what arrived and what is owed; the solver only decides what
 * to ask and how to move the price after each answer. Two or three rounds
 * settle it.
 */
import type { Hex } from "viem";
import type { Interaction, Leg, Order, Price, SimResult } from "./types.js";

export const ZERO: Hex = "0x0000000000000000000000000000000000000000";
export const WETH: Hex = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

export const low = (a: string): Hex => a.toLowerCase() as Hex;

/** Ether out is address zero on the order; in the pool and in the balance check it is WETH. */
export function asToken(t: Hex): Hex {
  return low(t) === ZERO ? WETH : low(t);
}

/** The two tokens of an order's pair, sorted, so both directions land in one batch. */
export function pairKey(o: Order): string {
  return [asToken(o.sellToken), asToken(o.buyToken)].sort().join(":");
}

export interface PairBatch {
  /** Sorted: a < b. */
  a: Hex;
  b: Hex;
  /** Orders selling `a` for `b`. */
  sellA: Order[];
  /** Orders selling `b` for `a`. */
  sellB: Order[];
}

export function groupByPair(orders: Order[]): PairBatch[] {
  const map = new Map<string, PairBatch>();
  for (const o of orders) {
    const s = asToken(o.sellToken);
    const bt = asToken(o.buyToken);
    const [a, b] = [s, bt].sort() as [Hex, Hex];
    const k = `${a}:${b}`;
    let pb = map.get(k);
    if (!pb) {
      pb = { a, b, sellA: [], sellB: [] };
      map.set(k, pb);
    }
    (s === a ? pb.sellA : pb.sellB).push(o);
  }
  return [...map.values()];
}

export const sum = (xs: bigint[]): bigint => xs.reduce((acc, x) => acc + x, 0n);

/** A batch's clearing price as a fraction: one `a` is worth `pA / pB` of `b`. */
export interface Clearing {
  pA: bigint;
  pB: bigint;
}

export function buyAmount(o: Order, batch: PairBatch, c: Clearing): bigint {
  return asToken(o.sellToken) === batch.a ? (o.sellAmount * c.pA) / c.pB : (o.sellAmount * c.pB) / c.pA;
}

export function prices(batch: PairBatch, c: Clearing): Price[] {
  return [
    { token: batch.a, price: c.pA },
    { token: batch.b, price: c.pB },
  ];
}

/**
 * The residual at a clearing price: what one side sells that the other does
 * not absorb. Exactly one of the two is non-zero (or both zero on a perfect
 * net). Chosen so the contract's balance in the *absorbed* token comes out
 * exactly even: the AMM only ever has to cover the bought token.
 */
export function residual(batch: PairBatch, c: Clearing): { a: bigint; b: bigint } {
  const SA = sum(batch.sellA.map((o) => o.sellAmount));
  const SB = sum(batch.sellB.map((o) => o.sellAmount));
  const owedB = sum(batch.sellA.map((o) => buyAmount(o, batch, c))); // b the a-sellers want
  const owedA = sum(batch.sellB.map((o) => buyAmount(o, batch, c))); // a the b-sellers want
  if (owedB > SB) {
    // Net demand for b: send the a that b-sellers did not take.
    return { a: SA > owedA ? SA - owedA : 0n, b: 0n };
  }
  if (owedA > SA) {
    return { a: 0n, b: SB > owedB ? SB - owedB : 0n };
  }
  return { a: 0n, b: 0n };
}

/**
 * The next clearing price given what the simulation reported.
 *
 * For the token in net demand, `delta` is what the contract holds after the
 * pulls and the AMM (the other side's sells plus the AMM's output) and `owed`
 * is what the current price promises. We want to owe `delta * (1 - fee)`, so
 * the price moves by exactly that ratio. If the batch nets perfectly (nothing
 * owed beyond what is held) the price stands.
 */
export function nextClearing(batch: PairBatch, c: Clearing, sim: SimResult, feeBps: bigint, res: { a: bigint; b: bigint }): Clearing {
  const ia = sim.tokens.findIndex((t) => low(t) === batch.a);
  const ib = sim.tokens.findIndex((t) => low(t) === batch.b);
  if (ia < 0 || ib < 0) return c;
  const target = (d: bigint) => (d * (10_000n - feeBps)) / 10_000n;
  const abs = (x: bigint) => (x < 0n ? -x : x);

  // The residual is sized so the *absorbed* token comes out exactly even. The
  // token the AMM fed is the other one: its price moves so that what is owed
  // becomes what is held, less the fee. A residual of `a` feeds `b`, and the
  // other way round; with no residual the batch nets perfectly and the price
  // stands (no AMM, no fee).
  let fed: "a" | "b" | null = res.a > 0n ? "b" : res.b > 0n ? "a" : null;
  if (!fed) {
    const gapA = abs(sim.delta[ia] - sim.owed[ia]);
    const gapB = abs(sim.delta[ib] - sim.owed[ib]);
    if (gapA === 0n && gapB === 0n) return c;
    fed = gapB >= gapA ? "b" : "a";
  }
  if (fed === "b") {
    if (sim.owed[ib] === 0n || sim.delta[ib] <= 0n) return c;
    // b-buyers are paid pA/pB per a. Scale pA so owedB' = target(heldB).
    return { pA: (c.pA * target(sim.delta[ib])) / sim.owed[ib], pB: c.pB };
  }
  if (sim.owed[ia] === 0n || sim.delta[ia] <= 0n) return c;
  // a-buyers are paid pB/pA per b. Scale pB so owedA' = target(heldA).
  return { pA: c.pA, pB: (c.pB * target(sim.delta[ia])) / sim.owed[ia] };
}

/** Whether the simulation is a settlement the contract would accept. */
export function acceptable(batch: PairBatch, sim: SimResult, maxFeeBps: bigint): { ok: boolean; why?: string } {
  for (let i = 0; i < sim.tokens.length; i++) {
    const t = low(sim.tokens[i]);
    if (t !== batch.a && t !== batch.b) continue;
    if (sim.delta[i] < sim.owed[i]) return { ok: false, why: `short ${sim.owed[i] - sim.delta[i]} of ${t}` };
    const fee = sim.delta[i] - sim.owed[i];
    // Volume in the contract's terms: everything sold of t plus everything bought of t.
    const sold = sum([...batch.sellA, ...batch.sellB].filter((o) => asToken(o.sellToken) === t).map((o) => o.sellAmount));
    const cap = ((sold + sim.owed[i]) * maxFeeBps) / 10_000n;
    if (fee > cap) return { ok: false, why: `fee ${fee} above cap ${cap} in ${t}` };
  }
  return { ok: true };
}

/** Orders whose limit the clearing price does not reach. */
export function limitFailures(batch: PairBatch, c: Clearing): Order[] {
  return [...batch.sellA, ...batch.sellB].filter((o) => buyAmount(o, batch, c) < o.minBuyAmount);
}

/** `batch` without `drop`. */
export function without(batch: PairBatch, drop: Order[]): PairBatch {
  const gone = new Set(drop);
  return { ...batch, sellA: batch.sellA.filter((o) => !gone.has(o)), sellB: batch.sellB.filter((o) => !gone.has(o)) };
}

/**
 * How much of the batch met a counterparty rather than the pool, in `a` units:
 * total a sold less the a that went to the AMM (or, for net-b batches, the a
 * that came back from it is not counted — only what was sold and absorbed).
 */
export function nettedA(batch: PairBatch, c: Clearing): bigint {
  const SA = sum(batch.sellA.map((o) => o.sellAmount));
  const owedA = sum(batch.sellB.map((o) => buyAmount(o, batch, c)));
  return SA < owedA ? SA : owedA;
}

/**
 * How one side's residual is spread across routes: `num[i]/den` of it goes
 * down route i. One route is `{ parts: [{legs, num: 1}], den: 1 }`. Splitting
 * across pools is the second of the only two things that lower impact on a
 * one-sided order (the first is a counterparty): each pool takes a smaller
 * bite, and the marginal prices equalise instead of one pool eating it all.
 */
export interface Allocation {
  parts: { legs: Leg[]; num: bigint }[];
  den: bigint;
}

export function single(legs: Leg[]): Allocation {
  return { parts: [{ legs, num: 1n }], den: 1n };
}

/** `amount` spread as the allocation says; rounding dust goes to the last part. */
export function spread(amount: bigint, alloc: Allocation): Interaction[] {
  const parts = alloc.parts.filter((p) => p.num > 0n);
  const xs: Interaction[] = [];
  let used = 0n;
  parts.forEach((p, i) => {
    const amt = i === parts.length - 1 ? amount - used : (amount * p.num) / alloc.den;
    used += amt;
    if (amt > 0n) xs.push({ legs: p.legs, amountIn: amt });
  });
  return xs;
}

/** Interactions that turn the residual into the token in demand. */
export function interactionsFor(res: { a: bigint; b: bigint }, routeAtoB: Allocation | null, routeBtoA: Allocation | null): Interaction[] {
  const xs: Interaction[] = [];
  if (res.a > 0n && routeAtoB) xs.push(...spread(res.a, routeAtoB));
  if (res.b > 0n && routeBtoA) xs.push(...spread(res.b, routeBtoA));
  return xs;
}

/**
 * Every way to split `den` units across `n` routes (compositions with zeros),
 * so a grid of candidate allocations can be simulated in one parallel round.
 */
export function compositions(n: number, den: bigint): bigint[][] {
  if (n === 1) return [[den]];
  const out: bigint[][] = [];
  for (let first = 0n; first <= den; first++) for (const rest of compositions(n - 1, den - first)) out.push([first, ...rest]);
  return out;
}

/**
 * The first guess: send both sides to the AMM in full, pay nobody, and read the
 * two outputs. A batch with only one side gets its rate from that side; with
 * both, the a-sellers' rate is used (the side in net demand is what the
 * iteration corrects).
 */
export function discoveryClearing(batch: PairBatch, outB: bigint, outA: bigint): Clearing | null {
  const SA = sum(batch.sellA.map((o) => o.sellAmount));
  const SB = sum(batch.sellB.map((o) => o.sellAmount));
  if (SA > 0n && outB > 0n) return { pA: outB, pB: SA };
  if (SB > 0n && outA > 0n) return { pA: SB, pB: outA };
  return null;
}
