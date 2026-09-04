import { test } from "node:test";
import assert from "node:assert/strict";
import { PoolBook, hotMids, rankTokens } from "../src/hotset.ts";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const GME = "0x1b0e319c6a659f002271b69db8a7df2f911c153e";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const word = (a: string) => "0x" + "0".repeat(24) + a.slice(2);

function bookOf(pairs: Record<string, [string, string]>): { book: PoolBook; calls: () => number } {
  let calls = 0;
  const book = new PoolBook(async (to, data) => {
    calls++;
    const p = pairs[to.toLowerCase()];
    if (!p) throw new Error("no such pool");
    return word(data === "0x0dfe1681" ? p[0] : p[1]);
  });
  return { book, calls: () => calls };
}

test("a pool's pair is asked for once and then remembered", async () => {
  const { book, calls } = bookOf({ "0xaa": [WETH, GME] });
  await book.learn(["0xAA", "0xaa", "0xAa"]);
  assert.deepEqual(book.known("0xaa"), [WETH, GME]);
  assert.equal(calls(), 2, "token0 and token1, once");
  await book.learn(["0xaa"]);
  assert.equal(calls(), 2, "not asked again");
});

test("a pool that will not answer is not retried", async () => {
  const { book, calls } = bookOf({});
  await book.learn(["0xbb"]);
  await book.learn(["0xbb"]);
  assert.equal(book.known("0xbb"), undefined);
  assert.equal(calls(), 2, "one failed attempt, never repeated");
});

test("tokens rank by how many swaps they took part in, and WETH is never a mid", async () => {
  const { book } = bookOf({ "0x1": [WETH, GME], "0x2": [WETH, USDG], "0x3": [WETH, GME] });
  await book.learn(["0x1", "0x2", "0x3"]);
  const logs = [
    ...Array(5).fill({ address: "0x1" }),
    ...Array(2).fill({ address: "0x2" }),
    ...Array(3).fill({ address: "0x3" }),
  ];
  const ranked = rankTokens(logs, book, [WETH]);
  assert.deepEqual(ranked, [{ address: GME, swaps: 8 }, { address: USDG, swaps: 2 }]);
});

test("pools whose pair could not be read are skipped, not guessed", async () => {
  const { book } = bookOf({ "0x1": [WETH, GME] });
  await book.learn(["0x1", "0x9"]);
  const ranked = rankTokens([{ address: "0x1" }, { address: "0x9" }], book, [WETH]);
  assert.deepEqual(ranked, [{ address: GME, swaps: 1 }]);
});

test("the hot set is the busiest tokens of the window, capped", async () => {
  const pairs: Record<string, [string, string]> = { "0x1": [WETH, GME], "0x2": [WETH, USDG] };
  const { book } = bookOf(pairs);
  const seen: unknown[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x2710"; // 10,000
    if (method === "eth_getLogs") {
      seen.push(params[0]);
      return [...Array(4).fill({ address: "0x1" }), { address: "0x2" }];
    }
    throw new Error(method);
  };
  const hot = await hotMids(rpc, book, { weth: WETH as `0x${string}`, limit: 1, lookbackBlocks: 3000 });
  assert.deepEqual(hot, [{ address: GME, swaps: 4 }], "busiest only, cap respected");
  assert.deepEqual(seen[0], {
    fromBlock: "0x1b58", // 10,000 - 3,000
    toBlock: "0x2710",
    topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"],
  });
});

test("an unreadable log range is the caller's problem, not a silent empty set", async () => {
  const { book } = bookOf({});
  const rpc = async (method: string) => {
    if (method === "eth_blockNumber") return "0x10";
    throw new Error("range too wide");
  };
  await assert.rejects(() => hotMids(rpc, book, { weth: WETH as `0x${string}` }), /range too wide/);
});
