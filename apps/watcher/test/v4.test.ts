import { test } from "node:test";
import assert from "node:assert/strict";
import { V4 } from "@ordofi/core";
import { OrdoStore } from "@ordofi/store";
import { extractPricePoints, extractTrades } from "../src/candles.ts";
import { backfillV4Pools, decodeInitialize, extractV4Initializes, V4_SCANNED_KEY } from "../src/v4.ts";
import { analyzeBlock } from "../src/detect.ts";

const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const POOL_ID = "0x62ae7553f1e6d182fd1608da3c0c3bb1581d2ddfeae9e004241fa3fca2dac968";
const SENDER_TOPIC = "0x000000000000000000000000" + "ab".repeat(20);

/** A V4 swap as the PoolManager emits it: the swapper pays 1 ETH (negative) and receives tokens. */
function v4SwapLog(address = V4.poolManager, id = POOL_ID) {
  const sqrt = BigInt(Math.round(Math.sqrt(2.43e-9) * 2 ** 96));
  const data =
    "0x" +
    word(-1_000_000_000_000_000_000n) + // amount0: swapper's delta, paid 1 ETH
    word(2_430_000_000n) + // amount1: swapper received
    word(sqrt) +
    word(5n) + // liquidity
    word(0n) + // tick
    word(3000n); // fee
  return { address, topics: [V4.swapTopic, id, SENDER_TOPIC], data, logIndex: "0x7", transactionHash: "0xtx" };
}

test("V4 swaps are keyed by PoolId with amounts flipped to the pool's side", () => {
  const rows = extractTrades(10, 1_700_000_000, [{ logs: [v4SwapLog()] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pool, POOL_ID, "the PoolId, not the PoolManager address");
  // V3 convention: positive means the pool received it. The swapper paid ETH,
  // so the pool received ETH.
  assert.equal(rows[0].amount0, "1000000000000000000");
  assert.equal(rows[0].amount1, "-2430000000");
  assert.equal(rows[0].logIndex, 7);

  const pts = extractPricePoints(10, 1_700_000_000, [{ logs: [v4SwapLog()] }]);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].pool, POOL_ID);
  assert.ok(Math.abs(pts[0].price - 2.43e-9) / 2.43e-9 < 1e-6);
  assert.equal(pts[0].vol0, 1e18);
  assert.equal(pts[0].vol1, 2.43e9);
});

test("a V4-shaped Swap from anything but the PoolManager is not taped", () => {
  const rows = extractTrades(10, 1, [{ logs: [v4SwapLog("0x" + "11".repeat(20))] }]);
  assert.equal(rows.length, 0, "a PoolId only means something inside the canonical singleton");
  // Five data words is a V3 layout wearing a V4 topic: refused, not misread.
  const short = { ...v4SwapLog(), data: "0x" + "0".repeat(64 * 5) };
  assert.equal(extractTrades(10, 1, [{ logs: [short] }]).length, 0);
});

// Initialize(id, ETH, 0xc9eb…0123, fee 3000, tickSpacing 200, hooks 0xf752…a0cc, sqrtPrice, tick 204200)
// as the PoolManager emitted it on Robinhood Chain at block 0x3276d19.
const REAL_INIT = {
  address: V4.poolManager,
  topics: [
    V4.initializeTopic,
    POOL_ID,
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x000000000000000000000000c9ebb7dec7eb06b6e27cceb4ab7ab8a0e7e50123",
  ],
  data:
    "0x0000000000000000000000000000000000000000000000000000000000000bb8" +
    "00000000000000000000000000000000000000000000000000000000000000c8" +
    "000000000000000000000000f7521cf0bb7c11e2d2794189412614cf2e29a0cc" +
    "0000000000000000000000000000000000006a17b32fc5d4d48f7124aa2fdba0" +
    "0000000000000000000000000000000000000000000000000000000000031da8",
  blockNumber: "0x3276d19",
  transactionHash: "0x929267fc1b3e71fb121bf258039bec514da64a2fcce3e286632d858b08824491",
};

test("Initialize decodes the full pool key, including native ETH and the hook", () => {
  const row = decodeInitialize(REAL_INIT, 0x3276d19, 1_700_000_000);
  assert.ok(row);
  assert.equal(row.poolId, POOL_ID);
  assert.equal(row.currency0, V4.nativeCurrency, "currency0 is native ETH");
  assert.equal(row.currency1, "0xc9ebb7dec7eb06b6e27cceb4ab7ab8a0e7e50123");
  assert.equal(row.fee, 3000);
  assert.equal(row.tickSpacing, 200);
  assert.equal(row.hooks, "0xf7521cf0bb7c11e2d2794189412614cf2e29a0cc");
  assert.equal(row.sqrtPrice, BigInt("0x6a17b32fc5d4d48f7124aa2fdba0").toString());
  assert.equal(row.tick, 204200);
  assert.equal(row.block, 0x3276d19);
  assert.equal(row.txHash, REAL_INIT.transactionHash);

  // Negative tick spacing / tick round-trip through two's complement.
  const neg = { ...REAL_INIT, data: "0x" + word(500n) + word(-10n) + word(0n) + word(1n) + word(-887272n) };
  assert.equal(decodeInitialize(neg, 1)?.tickSpacing, -10);
  assert.equal(decodeInitialize(neg, 1)?.tick, -887272);

  assert.equal(decodeInitialize({ ...REAL_INIT, address: "0x" + "22".repeat(20) }, 1), null, "only the PoolManager announces pools");
  assert.equal(decodeInitialize({ ...REAL_INIT, topics: [V4.swapTopic, POOL_ID, "0x0", "0x0"] }, 1), null);
});

test("extractV4Initializes finds pools in a block's receipts and the store keeps them once", () => {
  const rows = extractV4Initializes(0x3276d19, 1_700_000_000, [
    { transactionHash: "0xother", logs: [{ address: "0xfoo", topics: ["0x1234"], data: "0x" }] },
    { transactionHash: REAL_INIT.transactionHash, logs: [REAL_INIT] },
  ]);
  assert.equal(rows.length, 1);
  const s = new OrdoStore(":memory:");
  s.upsertV4Pools(rows);
  s.upsertV4Pools(rows); // the block replays after a restart
  assert.equal(s.v4PoolCount(), 1);
  const p = s.v4Pool(POOL_ID.toUpperCase().replace("0X", "0x"));
  assert.equal(p?.currency1, "0xc9ebb7dec7eb06b6e27cceb4ab7ab8a0e7e50123");
  assert.equal(p?.tickSpacing, 200);
  assert.equal(s.v4PoolsFor(V4.nativeCurrency).length, 1, "found from the ETH side");
  assert.equal(s.v4PoolsFor("0xc9ebb7dec7eb06b6e27cceb4ab7ab8a0e7e50123").length, 1, "and from the token side");
  assert.equal(s.v4PoolsForPair("0xc9ebb7dec7eb06b6e27cceb4ab7ab8a0e7e50123", V4.nativeCurrency).length, 1, "either order");
  assert.equal(s.v4PoolsByIds([POOL_ID, "0x" + "0".repeat(64)]).size, 1, "unknown ids are simply absent");
  s.close();
});

test("arb detection sees two V4 pools as two pools", () => {
  const swapA = v4SwapLog(V4.poolManager, POOL_ID);
  const swapB = v4SwapLog(V4.poolManager, "0x" + "ff".repeat(32));
  const receipt = {
    transactionHash: "0xarb", transactionIndex: "0x0", from: "0xbot", to: "0xexec", gasUsed: "0x1", status: "0x1",
    logs: [swapA, swapB].map((l) => ({ ...l, transactionIndex: "0x0" })),
  };
  const { swaps } = analyzeBlock(1, 1, [receipt as never]);
  assert.deepEqual(swaps.map((s) => s.pool), [POOL_ID, "0x" + "ff".repeat(32)]);
  assert.ok(swaps.every((s) => s.kind === "univ4"));
});

test("the Initialize walk shrinks refused windows, grows them back, and checkpoints", async () => {
  const s = new OrdoStore(":memory:");
  const calls: [number, number][] = [];
  const fetch = async (_m: string, params: unknown[]) => {
    const f = parseInt((params[0] as any).fromBlock, 16), t = parseInt((params[0] as any).toBlock, 16);
    if (t - f + 1 > 1000) throw new Error("Block range limit exceeded");
    calls.push([f, t]);
    // One pool appears in the window that contains block 12_345.
    return f <= 12_345 && 12_345 <= t ? [{ ...REAL_INIT, blockNumber: "0x3039" }] : [];
  };
  const reached = await backfillV4Pools(s, { toBlock: 20_000, maxSpan: 4_000, fetch, sleep: async () => {} });
  assert.equal(reached, 20_000);
  assert.equal(s.v4PoolCount(), 1);
  assert.equal(s.v4Pool(POOL_ID)?.block, 12_345);
  assert.equal(s.getMeta(V4_SCANNED_KEY), "20000");
  assert.equal(calls[0][0], V4.deployBlock, "starts at the PoolManager's deploy block");
  assert.ok(calls.every(([f, t]) => t - f + 1 <= 1000), "every served window respected the provider's cap");
  assert.ok(calls.length >= Math.ceil((20_000 - V4.deployBlock) / 1000));
  // Every block from deploy to the target was asked for exactly once, in order.
  for (let i = 1; i < calls.length; i++) assert.equal(calls[i][0], calls[i - 1][1] + 1);

  // A second run resumes from the checkpoint and asks for nothing already covered.
  calls.length = 0;
  await backfillV4Pools(s, { toBlock: 21_000, maxSpan: 4_000, fetch, sleep: async () => {} });
  assert.deepEqual(calls, [[20_001, 21_000]]);
  s.close();
});
