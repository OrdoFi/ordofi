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

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/** Two pools, sender receives `out` of USDG, plus whatever else is passed in. */
function swapReceipt(extraLogs: any[] = []) {
  return [
    {
      transactionHash: "0xfeed",
      transactionIndex: "0x0",
      from: searcher,
      to: executor,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3b9aca00",
      status: "0x1",
      logs: [
        { address: poolA, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xfeed", transactionIndex: "0x0", logIndex: "0x0" },
        { address: poolB, topics: [UNIV2_SWAP], data: "0x", transactionHash: "0xfeed", transactionIndex: "0x0", logIndex: "0x1" },
        {
          address: USDG,
          topics: [TRANSFER_TOPIC, addrTopic(poolB), addrTopic(searcher)],
          data: amount(166_832_655_237n), // 166,832.66 USDG, six decimals
          transactionHash: "0xfeed",
          transactionIndex: "0x0",
          logIndex: "0x2",
        },
        ...extraLogs,
      ],
    },
  ];
}

test("ETH paid as transaction value is not free money", () => {
  // Mainnet tx 0x8b0bbb8b…: 68 ETH in, 166,832 USDG out, across three pools.
  // Receipts carry no `value`, so the ETH side was invisible and the whole
  // output was booked as profit — $166,832 from one roughly break-even swap.
  const txValues = new Map([["0xfeed", 68_000_000_000_000_000_000n]]);

  const withoutValue = analyzeBlock(100, 1234, swapReceipt() as any);
  assert.equal(withoutValue.arbs[0]?.profitIsQuote, true, "fixture is the shape that used to inflate");

  const { arbs } = analyzeBlock(100, 1234, swapReceipt() as any, txValues);
  assert.equal(
    arbs.filter((a) => a.profitIsQuote).length,
    0,
    "paying 68 ETH for 166k USDG is a trade, not extracted value",
  );
});

test("spending a quote asset rules out a quote profit", () => {
  // Same shape but the ETH leg is WETH, so it is visible in the logs. Booking
  // the USDG output while ignoring the WETH cost is the same error.
  const wethOut = {
    address: WETH,
    topics: [TRANSFER_TOPIC, addrTopic(searcher), addrTopic(poolA)],
    data: amount(68_000_000_000_000_000_000n),
    transactionHash: "0xfeed",
    transactionIndex: "0x0",
    logIndex: "0x3",
  };

  const { arbs } = analyzeBlock(100, 1234, swapReceipt([wethOut]) as any);
  assert.equal(
    arbs.filter((a) => a.profitIsQuote).length,
    0,
    "sender is down 68 WETH; the USDG is what they bought",
  );
});

test("selling a token for a stablecoin is not extracted value", () => {
  // The dominant case on this chain: someone sells a tokenised stock for USDG.
  // Checking only quote assets for the spent side missed it entirely, because
  // the thing being sold is not a quote asset — and that was most of a
  // $45M/day chain-wide figure.
  const SPY = "0x9999999999999999999999999999999999999999";
  const spyOut = {
    address: SPY,
    topics: [TRANSFER_TOPIC, addrTopic(searcher), addrTopic(poolA)],
    data: amount(400_000_000_000_000_000_000n),
    transactionHash: "0xfeed",
    transactionIndex: "0x0",
    logIndex: "0x3",
  };

  const { arbs } = analyzeBlock(100, 1234, swapReceipt([spyOut]) as any);
  assert.equal(
    arbs.filter((a) => a.profitIsQuote).length,
    0,
    "the USDG is the proceeds of a sale, not profit",
  );
});

test("a genuine round trip still counts", () => {
  // WETH -> USDG -> WETH: the USDG nets to zero and the WETH is real profit.
  // The fix must not silence the thing we are trying to measure.
  const logs = [
    {
      address: USDG,
      topics: [TRANSFER_TOPIC, addrTopic(searcher), addrTopic(poolB)],
      data: amount(166_832_655_237n), // spends back every USDG received
      transactionHash: "0xfeed",
      transactionIndex: "0x0",
      logIndex: "0x3",
    },
    {
      address: WETH,
      topics: [TRANSFER_TOPIC, addrTopic(poolB), addrTopic(searcher)],
      data: amount(2_000_000_000_000_000n), // 0.002 WETH profit
      transactionHash: "0xfeed",
      transactionIndex: "0x0",
      logIndex: "0x4",
    },
  ];

  const { arbs } = analyzeBlock(100, 1234, swapReceipt(logs) as any);
  assert.equal(arbs.length, 1);
  assert.equal(arbs[0].profitIsQuote, true);
  assert.equal(arbs[0].profitToken, WETH.toLowerCase());
  assert.equal(arbs[0].profitWei, "2000000000000000");
});
