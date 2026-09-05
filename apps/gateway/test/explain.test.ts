import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeString, netFor, summarise, venuesIn } from "../src/explain.ts";

const ME = "0x9fdc67823988bf7acc68acd8c547e39b21162f65";
const OTHER = "0xeed311af4b78d8b9c142082504c1f6e21041f709";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

const topicAddr = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const transfer = (token: string, from: string, to: string, amount: bigint) => ({
  address: token,
  topics: [TRANSFER, topicAddr(from), topicAddr(to)],
  data: word(amount),
});

describe("what moved, from the sender's point of view", () => {
  it("nets a swap into one out and one in", () => {
    const net = netFor(ME, [transfer(USDG, ME, OTHER, 100_000000n), transfer(WETH, OTHER, ME, 40_000_000_000_000_000n)], 0n);
    assert.equal(net.get(USDG), -100_000000n);
    assert.equal(net.get(WETH), 40_000_000_000_000_000n);
  });

  it("counts native value as leaving", () => {
    const net = netFor(ME, [], 2_270_824_000_000_000_000n);
    assert.equal(net.get("eth"), -2_270_824_000_000_000_000n);
  });

  it("credits ether that unwrapping returns, which no Transfer records", () => {
    // The classic reason a swap looks like it paid you nothing.
    const net = netFor(ME, [{ address: WETH, topics: [WITHDRAWAL, topicAddr(ME)], data: word(10n ** 18n) }], 0n);
    assert.equal(net.get("eth"), 10n ** 18n);
  });

  it("ignores transfers between other people in the same transaction", () => {
    const net = netFor(ME, [transfer(USDG, OTHER, WETH, 5n)], 0n);
    assert.equal(net.size, 0);
  });

  it("collapses a round trip through the same token to nothing", () => {
    const net = netFor(ME, [transfer(USDG, ME, OTHER, 100n), transfer(USDG, OTHER, ME, 100n)], 0n);
    assert.equal(net.get(USDG), 0n);
  });
});

describe("venues", () => {
  it("names them, once each", () => {
    assert.deepEqual(venuesIn([{ topics: [V4_SWAP] }, { topics: [V4_SWAP] }]), ["Uniswap V4"]);
    assert.deepEqual(venuesIn([{ topics: [TRANSFER] }]), []);
  });
});

describe("the sentence", () => {
  const m = (symbol: string, amount: string) => ({ asset: "0x", symbol, amount, raw: "0" });

  it("reads like a person for a swap", () => {
    assert.equal(
      summarise({ status: true, paid: [m("USDG", "100")], got: [m("ETH", "0.0407")], approvals: [], venues: ["Uniswap V4"], to: null }),
      "Swapped 100 USDG for 0.0407 ETH through Uniswap V4.",
    );
  });

  it("says plainly when an approval was the whole transaction", () => {
    const s = summarise({
      status: true, paid: [], got: [], venues: [], to: null,
      approvals: [{ token: "0x", symbol: "USDG", spender: OTHER, unlimited: true, amount: "0" }],
    });
    assert.match(s, /unlimited amount of your USDG/);
    assert.match(s, /Nothing moved/, "which is exactly why nobody notices it");
  });

  it("does not dress up a revert", () => {
    assert.match(summarise({ status: false, paid: [], got: [], approvals: [], venues: [], to: null }), /reverted/);
  });

  it("handles a plain send", () => {
    assert.equal(
      summarise({ status: true, paid: [m("ETH", "2.27")], got: [], approvals: [], venues: [], to: OTHER }),
      `Sent 2.27 ETH to ${OTHER}.`,
    );
  });
});

describe("token symbols", () => {
  it("reads a normal string return", () => {
    const s = "0x" + "".padStart(64, "0").slice(0, 62) + "20" +
      "0000000000000000000000000000000000000000000000000000000000000004" +
      Buffer.from("USDG").toString("hex").padEnd(64, "0");
    assert.equal(decodeString(s), "USDG");
  });
  it("falls back for a bytes32 symbol", () => {
    assert.equal(decodeString("0x" + Buffer.from("WETH").toString("hex").padEnd(64, "0")), "WETH");
  });
  it("gives nothing back for nothing", () => {
    assert.equal(decodeString("0x"), "");
    assert.equal(decodeString(null), "");
  });
});
