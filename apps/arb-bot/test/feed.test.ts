/**
 * The filter that decides whether a feed transaction is worth a quote. It is
 * allowed to be generous — a false positive costs one quote — but it must
 * never miss a swap through a token we track, because a missed swap is an
 * opportunity that goes to somebody else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodePacked } from "viem";
import { tokensTouched } from "../src/feed.ts";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0x1b0e319c6a659f002271b69db8a7df2f911c153e"; // GME's pool token, lowercase
const OTHER = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";

test("a V3 path finds the tokens packed inside it", () => {
  const path = encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WETH as `0x${string}`, 500, TOKEN as `0x${string}`, 3000, WETH as `0x${string}`],
  );
  const found = tokensTouched(path, [TOKEN, OTHER]);
  assert.deepEqual(found, [TOKEN], "packed, unaligned, still found");
});

test("a word-aligned argument is found too, and case does not matter", () => {
  const data = encodeFunctionData({
    abi: [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }],
    args: [TOKEN as `0x${string}`, 1n],
  });
  assert.deepEqual(tokensTouched(data, [TOKEN]), [TOKEN], "padded to a 32-byte word");
  // Some upstreams hand back mixed-case hex; the search must not care.
  assert.deepEqual(tokensTouched(data.toUpperCase(), [TOKEN]), [TOKEN]);
  assert.deepEqual(tokensTouched(data, [TOKEN.toUpperCase().replace("0X", "0x")]), [TOKEN.toUpperCase().replace("0X", "0x")]);
});

test("a transaction touching nothing we track is skipped", () => {
  const path = encodePacked(["address", "uint24", "address"], [WETH as `0x${string}`, 500, OTHER as `0x${string}`]);
  assert.deepEqual(tokensTouched(path, [TOKEN]), []);
});

test("several tracked tokens in one transaction all come back", () => {
  const path = encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [TOKEN as `0x${string}`, 500, WETH as `0x${string}`, 3000, OTHER as `0x${string}`],
  );
  assert.deepEqual(new Set(tokensTouched(path, [TOKEN, OTHER])), new Set([TOKEN, OTHER]));
});
