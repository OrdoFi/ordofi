import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEventTopics, encodeAbiParameters, type Hex } from "viem";
import { SWAP_EVENTS, SwapStats } from "../src/swapstats.ts";

const ADDR: Hex = "0x00000000000000000000000000000000000000aa";
const USER: Hex = "0x00000000000000000000000000000000000000ee";

function reclaimed(block: number, profit: bigint, toUser: bigint, toProtocol: bigint, tx = "0x01" as Hex) {
  return {
    address: ADDR,
    topics: encodeEventTopics({ abi: SWAP_EVENTS, eventName: "Reclaimed", args: { recipient: USER } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [profit, toUser, toProtocol]),
    blockNumber: `0x${block.toString(16)}` as Hex,
    transactionHash: tx,
  };
}
function swapped(block: number) {
  return {
    address: ADDR,
    topics: encodeEventTopics({ abi: SWAP_EVENTS, eventName: "Swapped", args: { sender: USER, recipient: USER } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [USER, USER, 1n, 2n]),
    blockNumber: `0x${block.toString(16)}` as Hex,
    transactionHash: "0x02" as Hex,
  };
}
function skipped(block: number) {
  return {
    address: ADDR,
    topics: encodeEventTopics({ abi: SWAP_EVENTS, eventName: "ReclaimSkipped", args: { recipient: USER } }) as Hex[],
    data: encodeAbiParameters([{ type: "bytes" }], ["0x"]),
    blockNumber: `0x${block.toString(16)}` as Hex,
    transactionHash: "0x03" as Hex,
  };
}

test("swaps, reclaims and skips are tallied and the split is summed to the wei", () => {
  const s = new SwapStats(async () => null, ADDR, 100, null);
  s.ingest(swapped(101));
  s.ingest(reclaimed(101, 1000n, 900n, 100n));
  s.ingest(swapped(102));
  s.ingest(skipped(102));
  s.ingest(swapped(103));
  s.ingest(reclaimed(103, 50n, 45n, 5n, "0x09"));
  const t = s.totals();
  assert.equal(t.swaps, 3);
  assert.equal(t.reclaims, 2);
  assert.equal(t.skipped, 1);
  assert.equal(t.profitWei, "1050");
  assert.equal(t.toUserWei, "945");
  assert.equal(t.toProtocolWei, "105");
  assert.equal(t.recent[0].tx, "0x09", "newest first");
  assert.equal(t.recent[0].recipient.toLowerCase(), USER);
});

test("refresh reads forward in bounded chunks and remembers where it got to", async () => {
  const ranges: [number, number][] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x" + (100 + 12_000).toString(16);
    const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex };
    ranges.push([Number(fromBlock), Number(toBlock)]);
    return Number(fromBlock) === 100 ? [reclaimed(100, 10n, 9n, 1n)] : [];
  };
  const dir = mkdtempSync(join(tmpdir(), "ordo-swapstats-"));
  const file = join(dir, "s.json");
  const s = new SwapStats(rpc, ADDR, 100, file, 5_000, 2);
  await s.refresh();
  assert.deepEqual(ranges, [[100, 5099], [5100, 10099]], "two chunks per pass, no more");
  assert.equal(s.totals().scannedTo, 10099);
  assert.equal(s.totals().reclaims, 1);
  await s.refresh();
  assert.deepEqual(ranges.at(-1), [10100, 12100], "the next pass continues from where it stopped, to the head");

  // A fresh instance over the same file resumes rather than rescanning.
  const again = new SwapStats(rpc, ADDR, 100, file, 5_000, 2);
  assert.equal(again.totals().scannedTo, 12100);
  assert.equal(again.totals().reclaims, 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).address, ADDR);

  // A different contract address starts over.
  const other = new SwapStats(rpc, "0x00000000000000000000000000000000000000bb", 100, file, 5_000, 2);
  assert.equal(other.totals().scannedTo, 99);
});

const OLD: Hex = "0x00000000000000000000000000000000000000bb";

test("a redeploy does not reset the history: every deployment is counted, the live one is named", async () => {
  const filters: unknown[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x" + (200).toString(16);
    const f = params[0] as { address: unknown };
    filters.push(f.address);
    // One swap on the retired contract, one on the live one.
    return [swapped(150), { ...swapped(151), address: OLD }];
  };
  const s = new SwapStats(rpc, [ADDR, OLD], 100, null, 5_000, 2);
  await s.refresh();
  const t = s.totals();
  assert.deepEqual(t.addresses, [ADDR, OLD]);
  assert.equal(t.address, ADDR, "the live contract is the one the page links to");
  assert.deepEqual(filters[0], [ADDR, OLD], "one query covers both, since the events are identical");
  assert.equal(t.swaps, 2, "the retired contract's swaps still happened");
});

test("adding a past deployment rescans rather than trusting a position that skipped it", async () => {
  const rpc = async (method: string) => (method === "eth_blockNumber" ? "0x" + (12_100).toString(16) : []);
  const dir = mkdtempSync(join(tmpdir(), "ordo-swapstats-"));
  const file = join(dir, "s.json");
  const only = new SwapStats(rpc, ADDR, 100, file, 5_000, 40);
  await only.refresh();
  assert.equal(only.totals().scannedTo, 12_100);

  // The earlier contract lived in blocks this position has already passed, so
  // resuming would count none of it. The set changed: start again.
  const both = new SwapStats(rpc, [ADDR, OLD], 100, file, 5_000, 40);
  assert.equal(both.totals().scannedTo, 99, "back to the first deployment's block");
  assert.equal(both.totals().swaps, 0);

  // Same set in a different order is the same history, and resumes.
  await both.refresh();
  const resumed = new SwapStats(rpc, [OLD, ADDR], 100, file, 5_000, 40);
  assert.equal(resumed.totals().scannedTo, 12_100, "order names the live contract; it does not change what was counted");
  assert.equal(resumed.totals().address, OLD, "…but the first given is still the one the page links to");

  // Moving the start block earlier puts history behind a position that only
  // moves forward. Resuming there would never read it.
  const earlier = new SwapStats(rpc, [OLD, ADDR], 50, file, 5_000, 40);
  assert.equal(earlier.totals().scannedTo, 49, "rescan from the new start, not from the old position");
});
