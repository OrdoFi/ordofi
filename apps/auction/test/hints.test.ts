import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSwapHints, type SimLog } from "@ordofi/core/simulate";

/**
 * The three pool shapes sign their amounts differently — v2 reports gross
 * in/out legs, v3 signs from the pool's side, v4 from the swapper's side — so
 * each decoder is pinned against a log built by hand. Getting a sign backwards
 * would point every searcher at the wrong side of the trade, which is the one
 * failure mode a hint cannot have.
 */

const V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const data = (...v: bigint[]) => "0x" + v.map(word).join("");

const NOISE: SimLog = {
  address: "0xtoken",
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
  data: "0x",
};

test("univ2: a token0-in swap decodes as 0for1", () => {
  const log: SimLog = {
    address: "0xpool2",
    topics: [V2, "0xsender", "0xto"],
    // amount0In, amount1In, amount0Out, amount1Out
    data: data(1000n, 0n, 0n, 990n),
  };
  const [hint] = extractSwapHints([log]);
  assert.equal(hint.kind, "univ2");
  assert.equal(hint.pool, "0xpool2");
  assert.equal(hint.direction, "0for1");
});

test("univ2: a token1-in swap decodes as 1for0", () => {
  const log: SimLog = {
    address: "0xpool2",
    topics: [V2],
    data: data(0n, 1000n, 990n, 0n),
  };
  assert.equal(extractSwapHints([log])[0].direction, "1for0");
});

test("univ3: amounts are the pool's delta, so positive amount0 is 0for1", () => {
  const sell0: SimLog = { address: "0xpool3", topics: [V3], data: data(1000n, -990n, 1n, 1n, 0n) };
  const buy0: SimLog = { address: "0xpool3", topics: [V3], data: data(-990n, 1000n, 1n, 1n, 0n) };
  assert.equal(extractSwapHints([sell0])[0].direction, "0for1");
  assert.equal(extractSwapHints([buy0])[0].direction, "1for0");
});

test("univ4: amounts are the swapper's delta, so NEGATIVE amount0 is 0for1", () => {
  const poolId = "0x305d18bf4219ade3c36ae2a01fbfa354ca7b01bcad05320ce5c40fa0e16d3699";
  const log: SimLog = {
    address: "0xpoolmanager",
    topics: [V4, poolId, "0xsender"],
    data: data(-9550000000000000n, 144560621372718128590711n, 1n, 1n, 0n, 0n),
  };
  const [hint] = extractSwapHints([log]);
  assert.equal(hint.kind, "univ4");
  assert.equal(hint.direction, "0for1", "paying ether into a v4 pool is 0for1");
  assert.equal(hint.poolId, poolId, "v4 pools are identified by PoolId, not address");
});

test("hint levels: amounts are withheld unless the level is full", () => {
  const log: SimLog = { address: "0xpool3", topics: [V3], data: data(1000n, -990n, 1n, 1n, 0n) };

  assert.deepEqual(extractSwapHints([log], "minimal"), [], "minimal names no pools at all");

  const [pools] = extractSwapHints([log], "pools");
  assert.equal(pools.direction, "0for1", "direction is what prices a backrun");
  assert.equal(pools.amount0, undefined, "size is what would enable a front-run");

  const [full] = extractSwapHints([log], "full");
  assert.equal(full.amount0, "1000");
  assert.equal(full.amount1, "-990");
});

test("non-swap logs are ignored and repeated pools collapse to a set", () => {
  const log: SimLog = { address: "0xpool3", topics: [V3], data: data(1n, -1n, 1n, 1n, 0n) };
  const hints = extractSwapHints([NOISE, log, NOISE, log]);
  assert.equal(hints.length, 1, "a router hitting one pool twice is still one pool");
});

test("a malformed swap log degrades to the pool without a direction", () => {
  const truncated: SimLog = { address: "0xpool3", topics: [V3], data: "0x00" };
  const [hint] = extractSwapHints([truncated]);
  assert.equal(hint.pool, "0xpool3");
  assert.equal(hint.direction, undefined);
});
