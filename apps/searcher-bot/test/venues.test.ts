import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeErrorResult, parseAbi, type Hex } from "viem";
import { WETH } from "@ordofi/core";
import { NATIVE, ORDO_SWAP2_ABI, otherSide, type PoolKey } from "@ordofi/core/ordoswap";
import { cyclesForV4, priceCycles, v3TiersFor } from "../src/venues.ts";

const TOKEN = "0x1b0e319c6a659f002271b69db8a7df2f911c153e" as Hex;
const SWAP = "0x91275b7af677737c82697f5f70ffdee6208cf9cc" as Hex;
const POOL = "0x00000000000000000000000000000000000000dd" as Hex;

/** An ETH/token V4 pool, the way the chain spells one: ether is address zero. */
const etherKey: PoolKey = { currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE };
/** The same market as a WETH pair, for pools that hold the wrapper instead. */
const wethKey: PoolKey = { currency0: TOKEN, currency1: WETH as Hex, fee: 500, tickSpacing: 10, hooks: NATIVE };

const word = (n: bigint) => n.toString(16).padStart(64, "0");

describe("naming the market", () => {
  it("reads the token out of a pool that holds ether", () => {
    assert.equal(otherSide(etherKey, WETH as Hex, WETH as Hex), TOKEN);
  });
  it("and out of one that holds the wrapper", () => {
    assert.equal(otherSide(wethKey, WETH as Hex, WETH as Hex), TOKEN);
  });
});

describe("cross-venue cycles", () => {
  it("builds a round trip both ways for every V3 tier", () => {
    const cycles = cyclesForV4(etherKey, [500, 3000]);
    assert.equal(cycles.length, 4, "two tiers, two directions");
    // Both directions matter: the swap made one venue dear and the other cheap,
    // and the hint does not always say which.
    assert.ok(cycles.some((c) => c.label.includes(">v4>") && c.label.indexOf("v4") < c.label.indexOf("v3")));
    assert.ok(cycles.some((c) => c.label.indexOf("v3") < c.label.indexOf("v4")));
    for (const c of cycles) {
      assert.equal(c.legs.length, 2);
      assert.equal(c.token, TOKEN);
      assert.deepEqual(c.legs.map((l) => l.venue).sort(), [0, 1], "one leg each venue");
    }
  });

  it("points the V4 leg the right way round", () => {
    const [buyOnV4] = cyclesForV4(etherKey, [500]);
    // currency0 is ether and we are spending ether, so zeroForOne.
    assert.equal(buyOnV4.legs[0].zeroForOne, true);
    const sellOnV4 = cyclesForV4(etherKey, [500])[1];
    assert.equal(sellOnV4.legs[1].zeroForOne, false, "coming back the other way");
  });

  it("declines a pair that does not touch ether, which it could not settle in", () => {
    const usdcDai: PoolKey = { currency0: TOKEN, currency1: "0x00000000000000000000000000000000000000ab", fee: 100, tickSpacing: 1, hooks: NATIVE };
    assert.deepEqual(cyclesForV4(usdcDai, [500]), []);
  });

  it("has nothing to trade against when the pair has no V3 market", () => {
    assert.deepEqual(cyclesForV4(etherKey, []), []);
  });
});

describe("finding the V3 side", () => {
  const factoryReply = (pool: Hex) => ("0x" + pool.slice(2).padStart(64, "0")) as Hex;

  it("keeps the tiers that exist and drops the ones that do not", async () => {
    const call = async (_to: Hex, data: Hex) => {
      // The fee is the last of the three arguments.
      const fee = Number(BigInt("0x" + data.slice(10 + 128, 10 + 192)));
      return fee === 500 || fee === 10_000 ? factoryReply(POOL) : factoryReply("0x0" as Hex);
    };
    assert.deepEqual(await v3TiersFor(call, TOKEN), [500, 10_000]);
  });

  it("treats a factory that errors as no market rather than failing the bid", async () => {
    const call = async () => {
      throw new Error("upstream busy");
    };
    assert.deepEqual(await v3TiersFor(call, TOKEN), []);
  });
});

describe("pricing a cycle", () => {
  const cycles = cyclesForV4(etherKey, [500]);
  /** quote() answers by reverting with QuoteResult; that is the success path. */
  const quoter = (out: (amountIn: bigint) => bigint) => async (_to: Hex, data: Hex, opts?: { value?: bigint }) => {
    const amountIn = opts?.value ?? 0n;
    void data;
    throw Object.assign(new Error("execution reverted"), {
      data: encodeErrorResult({ abi: ORDO_SWAP2_ABI, errorName: "QuoteResult", args: [out(amountIn), 0n, "0x"] }),
    });
  };

  it("keeps the best size and direction, measured as what comes back", async () => {
    const best = await priceCycles(quoter((a) => (a * 103n) / 100n), SWAP, cycles, [100n, 1000n], { deadlineMs: 1000 });
    assert.ok(best);
    assert.equal(best.amountIn, 1000n, "the larger size returned more");
    assert.equal(best.amountOut, 1030n);
    assert.equal(best.grossWei, 30n);
  });

  it("returns nothing when the round trip loses money", async () => {
    const best = await priceCycles(quoter((a) => (a * 99n) / 100n), SWAP, cycles, [1000n], { deadlineMs: 1000 });
    assert.equal(best, null, "a cycle that returns less than it took is not an opportunity");
  });

  it("stops at the deadline rather than overrunning the bid window", async () => {
    let asked = 0;
    let clock = 0;
    const slow = async () => {
      asked++;
      clock += 60; // each quote is a round trip
      throw Object.assign(new Error("reverted"), {
        data: encodeErrorResult({ abi: ORDO_SWAP2_ABI, errorName: "QuoteResult", args: [2000n, 0n, "0x"] }),
      });
    };
    const many = cyclesForV4(etherKey, [100, 500, 3000, 10_000]);
    await priceCycles(slow, SWAP, many, [1000n], { deadlineMs: 120, now: () => clock });
    assert.ok(asked <= 3, `stopped after ${asked} quotes, not all ${many.length}`);
  });

  it("survives a quote that reverts for some other reason", async () => {
    const broken = async () => {
      throw new Error("STF");
    };
    assert.equal(await priceCycles(broken, SWAP, cycles, [1000n], { deadlineMs: 1000 }), null);
  });
});
