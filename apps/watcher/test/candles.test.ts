import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPricePoints } from "../src/candles.ts";

const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");

/** A WETH/USDG-shaped swap: sqrtPriceX96 for ~2430 USDG (6dp) per WETH (18dp). */
function v3Log(pool: string) {
  // price token1/token0 = 2430e6 / 1e18 = 2.43e-9; sqrt = sqrt(p) * 2^96
  const sqrt = BigInt(Math.round(Math.sqrt(2.43e-9) * 2 ** 96));
  const data =
    "0x" +
    word(-1_000_000_000_000_000_000n) + // amount0: pool pays out 1 WETH
    word(2_430_000_000n) + // amount1: pool receives 2430 USDG
    word(sqrt) +
    word(1n) + // liquidity
    word(0n); // tick
  return { address: pool, topics: [V3_SWAP, "0x0", "0x0"], data };
}

test("V3 swaps become price points; V2 carries no price and is skipped", () => {
  const receipts = [
    { logs: [v3Log("0xAbCPool"), { address: "0xv2", topics: [V2_SWAP], data: "0x" + "0".repeat(64 * 5) }] },
    { logs: [] },
  ];
  const pts = extractPricePoints(50_000, 1_700_000_123, receipts, 60);
  assert.equal(pts.length, 1, "only the V3 swap is priced");
  const p = pts[0];
  assert.equal(p.pool, "0xabcpool", "pool addresses are folded to lowercase");
  assert.equal(p.bucket, Math.floor(1_700_000_123 / 60) * 60);
  assert.equal(p.block, 50_000);
  assert.ok(Math.abs(p.price - 2.43e-9) / 2.43e-9 < 1e-6, `price ${p.price} ≈ 2.43e-9`);
  assert.equal(p.vol0, 1e18, "negative amounts are magnitudes");
  assert.equal(p.vol1, 2.43e9);
});

test("garbage logs are ignored rather than fatal", () => {
  const receipts = [{ logs: [{ address: "0xp", topics: [V3_SWAP], data: "0x1234" }] }, {}];
  assert.equal(extractPricePoints(1, 60, receipts as never).length, 0);
});

test("extractTrades keeps exact signed amounts and identifies the log", async () => {
  const { extractTrades } = await import("../src/candles.ts");
  const { SWAP_TOPICS } = await import("@ordofi/core");
  const topic = Object.entries(SWAP_TOPICS).find(([, v]) => v === "univ3")![0];
  const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, "0");
  const data = "0x" + word(-5000n) + word(12_500_000n) + word(79228162514264337593543950336n) + word(1n) + word(0n);
  const rows = extractTrades(77, 1_700_000_000, [
    { transactionHash: "0xabc", logs: [{ address: "0xPOOL", topics: [topic], data, logIndex: "0x2" }] },
    { transactionHash: "0xdef", logs: [{ address: "0xother", topics: ["0x1234"], data: "0x" }] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    pool: "0xpool", block: 77, logIndex: 2, txHash: "0xabc",
    amount0: "-5000", amount1: "12500000", sqrtPrice: "79228162514264337593543950336", ts: 1_700_000_000,
  });
});
