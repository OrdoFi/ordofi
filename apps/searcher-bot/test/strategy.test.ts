/**
 * The bid has to follow the quote. What this guards against is the previous
 * behaviour: a fixed bid on every opportunity, which paid the operator's own
 * money to users on rounds where nothing was captured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hex } from "viem";
import { CycleCache, bidFor, evaluate, pickBest, sizeLadder, type StrategyConfig } from "../src/strategy.ts";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Hex;
const TOKEN = "0x1111111111111111111111111111111111111111" as Hex;

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  base: WETH,
  maxBidWei: parseEther("0.001"),
  budgetWei: parseEther("0.03"),
  gasCostWei: parseEther("0.0002"),
  minProfitWei: parseEther("0.000004"),
  bidSharePct: 70n,
  ...over,
});

const cycle = { label: "t 500/3000", tokens: [WETH, TOKEN, WETH] as Hex[], fees: [500, 3000] };

test("a round trip that does not clear gas is not bid on", () => {
  // 0.00015 ETH of edge against 0.0002 ETH of gas is a loss, however tempting.
  assert.equal(bidFor(parseEther("0.00015"), cfg()), 0n);
  // Clearing gas by less than the minimum profit is still not worth a transaction.
  assert.equal(bidFor(parseEther("0.000201"), cfg()), 0n);
});

test("what is bid is a share of what survives gas, capped", () => {
  // 0.0012 gross - 0.0002 gas = 0.001 net; 70% of it is offered.
  assert.equal(bidFor(parseEther("0.0012"), cfg()), parseEther("0.0007"));
  // The cap binds before the share does.
  assert.equal(bidFor(parseEther("0.01"), cfg({ maxBidWei: parseEther("0.002") })), parseEther("0.002"));
});

test("the best quote is the most profitable one, and a losing set has no best", () => {
  const q = (amountIn: bigint, amountOut: bigint) => ({ cycle, amountIn, amountOut, grossWei: amountOut - amountIn });
  assert.equal(pickBest([]), null);
  assert.equal(pickBest([q(100n, 90n), q(200n, 150n)]), null, "everything at a loss");
  assert.equal(pickBest([q(100n, 110n), q(200n, 260n)])!.grossWei, 60n);
});

test("sizes are probed at a third and the whole budget, and never at zero", () => {
  assert.deepEqual(sizeLadder(parseEther("0.03")), [parseEther("0.01"), parseEther("0.03")]);
  assert.deepEqual(sizeLadder(0n), []);
  assert.deepEqual(sizeLadder(2n), [2n], "a budget too small to divide is probed once");
});

test("evaluate declines when there is no capital, no cycle, or no edge", async () => {
  const never = async () => "0x" as Hex;
  assert.match((await evaluate(never, [], cfg())).reason, /no cross-tier cycle/);
  assert.match((await evaluate(never, [cycle], cfg({ budgetWei: 0n }))).reason, /no capital/);

  // A quoter that always returns less than went in.
  const losing = async () =>
    ("0x" +
      (parseEther("0.009")).toString(16).padStart(64, "0") +
      "0".repeat(192)) as Hex;
  const out = await evaluate(losing, [cycle], cfg({ budgetWei: parseEther("0.01") }));
  assert.equal(out.bidWei, 0n);
  assert.equal(out.best, null);
});

test("a pool that does not touch the base token opens no cycles, and is asked about once", async () => {
  let calls = 0;
  const call = async (_to: string, data: Hex): Promise<Hex> => {
    calls++;
    // token0() / token1(): two tokens, neither of them WETH.
    if (data.startsWith("0x0dfe1681")) return ("0x" + "22".repeat(32)) as Hex;
    if (data.startsWith("0xd21220a7")) return ("0x" + "33".repeat(32)) as Hex;
    return ("0x" + "0".repeat(64)) as Hex;
  };
  const cache = new CycleCache(call, WETH);
  assert.deepEqual(await cache.cyclesFor("0xpool"), []);
  const after = calls;
  assert.deepEqual(await cache.cyclesFor("0xpool"), [], "second look is free");
  assert.equal(calls, after, "the pair was remembered");
});
