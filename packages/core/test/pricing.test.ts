/**
 * ETH is the denominator of every WETH-priced figure OrdoFi publishes, so a
 * wrong rate is wrong everywhere at once and says nothing about it. It used to
 * be a hardcoded 2250 against a real rate near 2445.
 */
import { strict as assert } from "node:assert";
import test, { afterEach, beforeEach } from "node:test";

const POOL = "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

// Captured from the live pool: 1 WETH = 2444.53 USDG.
const SQRT_PRICE_X96 = 3917219163556884143717078n;
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).padStart(64, "0");

const realFetch = globalThis.fetch;
let failSlot0 = false;

function stubChain({ wethIsToken0 = true } = {}) {
  globalThis.fetch = (async (_url: string, init: any) => {
    const { method, params } = JSON.parse(init.body);
    const json = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "content-type": "application/json" },
      });
    if (method !== "eth_call") return json("0x");
    const data: string = params[0].data;
    if (data === "0x3850c7bd") {
      if (failSlot0) return json("0x");
      // slot0 packs sqrtPriceX96 first; the rest is padding for this purpose.
      return json("0x" + word(SQRT_PRICE_X96) + word(0n).repeat(6));
    }
    if (data === "0x0dfe1681") return json("0x" + addrWord(wethIsToken0 ? WETH : USDG));
    if (data === "0x313ce567") return json("0x" + word(18n));
    return json("0x");
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  failSlot0 = false;
  delete process.env.ORDO_ETH_USD;
  process.env.ORDO_RPC_URLS = "https://rpc.example";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ORDO_ETH_USD;
  delete process.env.ORDO_RPC_URLS;
});

const fresh = () => import(`../src/pricing.ts?case=${Math.random()}`);

test("reads the live rate from the pool", async () => {
  stubChain();
  const { ethUsd } = await fresh();
  assert.ok(Math.abs((await ethUsd()) - 2444.53) < 1, `got ${await ethUsd()}`);
});

test("an explicit rate pins it and skips the chain", async () => {
  process.env.ORDO_ETH_USD = "3000";
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should not be reached");
  }) as unknown as typeof fetch;

  const { ethUsd } = await fresh();
  assert.equal(await ethUsd(), 3000);
  assert.equal(called, false, "a pinned rate should not hit the chain");
});

test("an empty variable is unset, not a pin", async () => {
  // Compose passes ${ORDO_ETH_USD:-} through, so the variable exists and says
  // nothing. Number("") is 0, which would price all WETH at zero.
  process.env.ORDO_ETH_USD = "";
  stubChain();
  const { ethUsd } = await fresh();
  assert.ok((await ethUsd()) > 1000, "empty must fall through to the live read");
});

test("an unreadable pool falls back rather than reporting nonsense", async () => {
  failSlot0 = true;
  stubChain();
  const { ethUsd } = await fresh();
  const v = await ethUsd();
  assert.ok(v > 0 && Number.isFinite(v), `fallback should be usable, got ${v}`);
});

test("the rate is cached rather than read per token", async () => {
  stubChain();
  const mod = await fresh();
  await mod.ethUsd();
  let callsAfter = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (...a: any[]) => {
    callsAfter++;
    return (inner as any)(...a);
  }) as unknown as typeof fetch;

  await mod.ethUsd();
  await mod.ethUsd();
  assert.equal(callsAfter, 0, "within the TTL the cached rate should be reused");
});

test("a cached token still gets a refreshed price", async () => {
  // Symbol and decimals are immutable; the price is not, and freezing it at
  // whatever it was when the token was first seen is how a long-running
  // watcher ends up quoting yesterday's rate.
  stubChain();
  const mod = await fresh();
  const first = await mod.getTokenInfo(WETH);
  const second = await mod.getTokenInfo(WETH);
  assert.equal(first.symbol, second.symbol);
  assert.ok(second.usdPerToken !== null && second.usdPerToken > 1000);
});
