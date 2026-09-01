import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBlock } from "../src/detect.ts";
import { WETH, TRANSFER_TOPIC } from "@ordofi/core";

const UNIV2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const poolA = "0x1111111111111111111111111111111111111111";
const poolB = "0x2222222222222222222222222222222222222222";
const searcher = "0x3333333333333333333333333333333333333333";
const executor = "0x4444444444444444444444444444444444444444";

function addrTopic(a: string) {
  return "0x" + a.slice(2).padStart(64, "0");
}
function amount(n: bigint) {
  return "0x" + n.toString(16).padStart(64, "0");
}

test("detects a two-pool atomic arb with WETH (quote) profit", () => {
  const receipts = [
    {
      transactionHash: "0xabc",
      transactionIndex: "0x0",
      from: searcher,
      to: executor,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3b9aca00",
      status: "0x1",
      logs: [
        { address: poolA, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xabc", transactionIndex: "0x0", logIndex: "0x0" },
        { address: poolB, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xabc", transactionIndex: "0x0", logIndex: "0x1" },
        // WETH transferred from poolB to the executor (non-pool beneficiary) => profit
        {
          address: WETH,
          topics: [TRANSFER_TOPIC, addrTopic(poolB), addrTopic(executor)],
          data: amount(1000000000000000n),
          transactionHash: "0xabc",
          transactionIndex: "0x0",
          logIndex: "0x2",
        },
      ],
    },
  ];

  const { swaps, arbs } = analyzeBlock(100, 1234, receipts as any);
  assert.equal(swaps.length, 2, "two swaps detected");
  assert.equal(arbs.length, 1, "one arb detected");
  assert.equal(arbs[0].profitIsQuote, true, "profit denominated in a quote token");
  assert.equal(arbs[0].profitToken, WETH.toLowerCase());
  assert.equal(arbs[0].profitWei, "1000000000000000");
  assert.equal(arbs[0].sender, searcher.toLowerCase());
});

test("ignores single-pool swaps (not an arb)", () => {
  const receipts = [
    {
      transactionHash: "0xdef",
      transactionIndex: "0x1",
      from: searcher,
      to: executor,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3b9aca00",
      status: "0x1",
      logs: [{ address: poolA, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xdef", transactionIndex: "0x1", logIndex: "0x0" }],
    },
  ];
  const { arbs } = analyzeBlock(101, 1235, receipts as any);
  assert.equal(arbs.length, 0);
});

test("a user's multi-pool swap is not counted as searcher profit", () => {
  // The exact shape that inflated the chain-wide figure to ~$150M/day: an
  // ordinary trade routed through two pools, where the *recipient* ends up
  // net-positive in a quote token. The recipient is neither the sender nor
  // the contract it called, so nothing here is the searcher's profit.
  const user = "0x5555555555555555555555555555555555555555";
  const router = "0x6666666666666666666666666666666666666666";
  const recipient = "0x7777777777777777777777777777777777777777";

  const receipts = [
    {
      transactionHash: "0xdef",
      transactionIndex: "0x0",
      from: user,
      to: router,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3b9aca00",
      status: "0x1",
      logs: [
        { address: poolA, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xdef", transactionIndex: "0x0", logIndex: "0x0" },
        { address: poolB, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xdef", transactionIndex: "0x0", logIndex: "0x1" },
        {
          address: WETH,
          topics: [TRANSFER_TOPIC, addrTopic(poolB), addrTopic(recipient)],
          data: amount(5000000000000000000n), // 5 WETH of swap output
          transactionHash: "0xdef",
          transactionIndex: "0x0",
          logIndex: "0x2",
        },
      ],
    },
  ];

  const { arbs } = analyzeBlock(101, 1235, receipts as any);
  const quotePriced = arbs.filter((a) => a.profitIsQuote);
  assert.equal(quotePriced.length, 0, "swap output to a third party is not extracted value");
});
