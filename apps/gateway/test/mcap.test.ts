import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SANE_CAP_USD, MarketCaps, SPOT_TTL_MS, priceFromSqrt, pricingPool } from "../src/mcap.ts";
import { NATIVE, USDG, WETH, resetCaches, type Pool } from "../src/ordoswap2.ts";

const Q96 = 2n ** 96n;
/** The sqrtPriceX96 a pool holding `p` of currency1 per currency0 (raw units) reports. */
const sqrtOf = (p: number) => BigInt(Math.floor(Math.sqrt(p) * Number(Q96)));

const TOKEN = "0xfe2f0fb0c00d19786a8abf98d4b1f1ac8763b167";

test("a pool's sqrt price becomes a price per whole token, either way round", () => {
  // 1 token (18dp) = 0.0004 ether (18dp); same decimals, so no shift.
  const p = priceFromSqrt(sqrtOf(0.0004), true, 18, 18);
  assert.ok(Math.abs(p! - 0.0004) / 0.0004 < 1e-6, `got ${p}`);
  // The same pool read from the other side is the reciprocal.
  const inv = priceFromSqrt(sqrtOf(0.0004), false, 18, 18);
  assert.ok(Math.abs(inv! - 2500) / 2500 < 1e-6, `got ${inv}`);
});

test("decimals are taken out of the ratio, not left in it", () => {
  // 1 token (18dp) = 2 USDG (6dp). Raw ratio is 2e6/1e18 = 2e-12.
  const p = priceFromSqrt(sqrtOf(2e-12), true, 18, 6);
  assert.ok(Math.abs(p! - 2) / 2 < 1e-6, `got ${p}`);
});

test("a price that is not a price is refused rather than guessed", () => {
  assert.equal(priceFromSqrt(0n, true, 18, 18), null);
  assert.equal(priceFromSqrt(-1n, true, 18, 18), null);
});

const v4 = (id: string, c0: string, c1: string, liquidity?: bigint): Pool => ({
  venue: "v4", a: c0 as `0x${string}`, b: c1 as `0x${string}`, fee: 3000, id: `v4:${id}`, liquidity,
  key: { currency0: c0 as `0x${string}`, currency1: c1 as `0x${string}`, fee: 3000, tickSpacing: 60, hooks: NATIVE },
});

test("pricing uses a live pool quoted against money we can value", () => {
  const other = "0x1111111111111111111111111111111111111111";
  const pools = [
    { venue: "v3", a: TOKEN, b: WETH, fee: 500, id: "v3:x:500" } as Pool, // no key to read a price from
    v4("0xaa", TOKEN, other, 5n), // priced against something we cannot value
    v4("0xbb", TOKEN, USDG, 0n), // empty
    v4("0xcc", NATIVE, TOKEN, 9n), // this one
  ];
  assert.equal(pricingPool(pools, TOKEN)?.id, "v4:0xcc");
  assert.equal(pricingPool([pools[1]], TOKEN), null, "no valuable side, no price");
  assert.equal(pricingPool([], TOKEN), null);
});

test("a cap is supply times price, and the chain is asked once an hour", async () => {
  resetCaches();
  let supplyCalls = 0;
  const rpc = async (method: string, params: unknown[]) => {
    const to = (params[0] as { to: string; data: string }).to.toLowerCase();
    const data = (params[0] as { data: string }).data;
    if (data === "0x18160ddd") { supplyCalls++; return "0x" + (1_000_000_000n * 10n ** 18n).toString(16).padStart(64, "0"); }
    throw new Error(`unexpected ${method} to ${to}`);
  };
  const caps = new MarketCaps(rpc, null);
  await caps.refresh([{ address: TOKEN, decimals: 18, usd: 0.05, v4: true }], 2500);
  assert.equal(caps.get(TOKEN), 50_000_000, "1e9 supply at $0.05");
  assert.equal(caps.get(TOKEN.toUpperCase()), 50_000_000, "address case does not matter");
  assert.equal(supplyCalls, 1);
  await caps.refresh([{ address: TOKEN, decimals: 18, usd: 0.05, v4: true }], 2500);
  assert.equal(supplyCalls, 1, "supply is cached, not re-read");
});

test("a token the app cannot price is priced from its own pool", async () => {
  resetCaches();
  const poolId = "0x" + "cc".repeat(32);
  const rpc = async (_m: string, params: unknown[]) => {
    const { to, data } = params[0] as { to: string; data: string };
    if (data === "0x18160ddd") return "0x" + (1_000_000_000n * 10n ** 18n).toString(16).padStart(64, "0");
    // StateView.getSlot0. The pool is ether/token in that order, and the price is
    // currency1 per currency0: 2500 tokens to the ether, so a token is 0.0004 of one.
    if (to.toLowerCase() === "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b") {
      return "0x" + sqrtOf(2500).toString(16).padStart(64, "0") + "0".repeat(192);
    }
    if (data.startsWith("0x1698ee82")) return "0x" + "0".repeat(64); // V3 factory: no pool for this pair
    throw new Error(`unexpected call to ${to}`);
  };
  const v4Source = {
    v4PoolsForPair: (a: string, b: string) =>
      [a, b].includes(TOKEN) && [a, b].includes(NATIVE)
        ? [{ poolId, currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE }]
        : [],
  };
  const caps = new MarketCaps(rpc, v4Source);
  await caps.refresh([{ address: TOKEN, decimals: 18, usd: null, v4: true }], 2500);
  // 0.0004 ETH × $2500 = $1 a token; a billion of them.
  const got = caps.get(TOKEN)!;
  assert.ok(Math.abs(got - 1e9) / 1e9 < 1e-3, `got ${got}`);
});

test("the pricing pool is found once; refreshing a price is one call, not a rediscovery", async () => {
  resetCaches();
  const poolId = "0x" + "cc".repeat(32);
  let discovery = 0, slot0 = 0;
  const rpc = async (_m: string, params: unknown[]) => {
    const { to, data } = params[0] as { to: string; data: string };
    if (data === "0x18160ddd") return "0x" + (1_000_000_000n * 10n ** 18n).toString(16).padStart(64, "0");
    if (to.toLowerCase() === "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b") { slot0++; return "0x" + sqrtOf(2500).toString(16).padStart(64, "0") + "0".repeat(192); }
    if (data.startsWith("0x1698ee82")) { discovery++; return "0x" + "0".repeat(64); }
    throw new Error(`unexpected call to ${to}`);
  };
  const v4Source = {
    v4PoolsForPair: (a: string, b: string) =>
      [a, b].includes(TOKEN) && [a, b].includes(NATIVE)
        ? [{ poolId, currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE }]
        : [],
  };
  const caps = new MarketCaps(rpc, v4Source);
  const token = [{ address: TOKEN, decimals: 18, usd: null, v4: true }];
  await caps.refresh(token, 2500);
  assert.ok(discovery > 0, "the first pass goes looking for a pool");
  assert.equal(slot0, 1);

  // Past the price's life but well inside the pool's: re-read, do not re-discover.
  const found = discovery;
  resetCaches(); // the router's own pair cache expires sooner than ours; ours must still hold
  await caps.refresh(token, 2500, undefined, Date.now() + SPOT_TTL_MS + 1);
  assert.equal(discovery, found, "the pool is remembered");
  assert.equal(slot0, 2, "one call to refresh a price");
});

test("a cap that cannot be believed is not shown", async () => {
  resetCaches();
  const supply = (v: bigint) => async () => "0x" + v.toString(16).padStart(64, "0");
  let answer = supply(10n ** 40n); // an absurd supply
  const caps = new MarketCaps(async () => answer(), null);
  await caps.refresh([{ address: TOKEN, decimals: 18, usd: 1000, v4: false }], null);
  assert.equal(caps.get(TOKEN), null, `over $${MAX_SANE_CAP_USD} is an artefact, not a cap`);

  answer = supply(0n);
  const zero = new MarketCaps(async () => answer(), null);
  await zero.refresh([{ address: TOKEN, decimals: 18, usd: 1, v4: false }], null);
  assert.equal(zero.get(TOKEN), null, "no supply, no cap");

  const unpriced = new MarketCaps(async () => { throw new Error("should not be asked"); }, null);
  await unpriced.refresh([{ address: TOKEN, decimals: 18, usd: null, v4: false }], null);
  assert.equal(unpriced.get(TOKEN), null, "no price and no V4 pool: nothing to ask the chain about");
});

test("a chain that will not answer leaves the picker without caps, not broken", async () => {
  resetCaches();
  const caps = new MarketCaps(async () => { throw new Error("upstream down"); }, null);
  await caps.refresh([{ address: TOKEN, decimals: 18, usd: 1, v4: true }], 2500);
  assert.equal(caps.get(TOKEN), null);
  assert.equal(caps.size(), 0);
});
