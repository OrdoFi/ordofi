import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLogsWide, isRangeRefusal, resolveRange } from "../src/getlogs.ts";

const RANGE_ERR = "Block range limit exceeded. See more details at https://docs.chainstack.com/docs/limits#evm-range-limits.";
const SIZE_ERR = "logs matched by query exceeds limit of 10000";

/** An upstream that serves at most `span` blocks and `cap` logs per request. */
function upstream(opts: { span: number; cap?: number; logsPerBlock?: number; head?: number }) {
  const { span, cap = Infinity, logsPerBlock = 1, head = 1000 } = opts;
  const calls: { from: number; to: number }[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
    const f = params[0] as { fromBlock?: string; toBlock?: string; blockHash?: string };
    if (f.blockHash) return [{ blockHash: f.blockHash }];
    const from = Number(f.fromBlock ?? 0);
    const to = Number(f.toBlock ?? head);
    calls.push({ from, to });
    if (to - from + 1 > span) throw new Error(RANGE_ERR);
    const n = (to - from + 1) * logsPerBlock;
    if (n > cap) throw new Error(SIZE_ERR);
    return Array.from({ length: n }, (_, i) => ({ blockNumber: `0x${(from + Math.floor(i / logsPerBlock)).toString(16)}` }));
  };
  return { rpc, calls };
}

describe("recognising a refusal", () => {
  it("knows the two the chain's provider actually sends", () => {
    assert.equal(isRangeRefusal(new Error(RANGE_ERR)), true);
    assert.equal(isRangeRefusal(new Error(SIZE_ERR)), true);
  });
  it("and the wordings other providers use", () => {
    for (const m of ["query returned more than 10000 results", "range too large", "log response size exceeded"]) {
      assert.equal(isRangeRefusal(new Error(m)), true, m);
    }
  });
  it("does not mistake a real failure for one", () => {
    // These must propagate: retrying them in halves would just fail four times.
    for (const m of ["execution reverted", "invalid argument", "the network is busy"]) {
      assert.equal(isRangeRefusal(new Error(m)), false, m);
    }
  });
});

describe("resolving the range", () => {
  it("turns tags into numbers so a range can be halved", async () => {
    const { rpc } = upstream({ span: 10, head: 500 });
    assert.deepEqual(await resolveRange(rpc, { fromBlock: "0x64", toBlock: "latest" }), { from: 100, to: 500 });
    assert.deepEqual(await resolveRange(rpc, { fromBlock: "earliest", toBlock: "0xa" }), { from: 0, to: 10 });
    assert.deepEqual(await resolveRange(rpc, {}), { from: 0, to: 500 }, "no bounds means everything");
  });
});

describe("answering a wide query", () => {
  it("costs one request when the upstream is happy", async () => {
    const { rpc, calls } = upstream({ span: 10_000 });
    const logs = await getLogsWide(rpc, { fromBlock: "0x0", toBlock: "0x63" });
    assert.equal(logs.length, 100);
    assert.equal(calls.length, 1, "the common case must not pay for the uncommon one");
  });

  it("splits a range the upstream refuses, and keeps block order", async () => {
    // 400 blocks, served 100 at a time.
    const { rpc } = upstream({ span: 100, head: 1000 });
    const logs = (await getLogsWide(rpc, { fromBlock: "0x0", toBlock: "0x18f" })) as { blockNumber: string }[];
    assert.equal(logs.length, 400, "every block in the range is accounted for");
    const nums = logs.map((l) => Number(l.blockNumber));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "in order, because the halves are walked in order");
    assert.equal(nums[0], 0);
    assert.equal(nums[nums.length - 1], 399);
  });

  it("splits again when it is the result size that was too big, not the span", async () => {
    // The span is fine everywhere; only wide slices return too many logs.
    const { rpc } = upstream({ span: 1e9, cap: 50, logsPerBlock: 1 });
    const logs = await getLogsWide(rpc, { fromBlock: "0x0", toBlock: "0xc7" });
    assert.equal(logs.length, 200);
  });

  it("resolves latest so a query with no upper bound still works", async () => {
    const { rpc } = upstream({ span: 100, head: 250 });
    const logs = await getLogsWide(rpc, { fromBlock: "0x0" });
    assert.equal(logs.length, 251);
  });

  it("passes a blockHash query straight through — there is no range to divide", async () => {
    const { rpc, calls } = upstream({ span: 1 });
    const logs = await getLogsWide(rpc, { blockHash: "0xabc" });
    assert.deepEqual(logs, [{ blockHash: "0xabc" }]);
    assert.equal(calls.length, 0);
  });

  it("refuses rather than truncating when the range needs too much work", async () => {
    // One block at a time over a huge range: honest failure beats a short
    // answer, because a caller cannot tell a short answer from a complete one.
    const { rpc } = upstream({ span: 1, head: 100_000 });
    await assert.rejects(
      () => getLogsWide(rpc, { fromBlock: "0x0", toBlock: "0x1869f" }, { maxCalls: 12 }),
      (e: Error) => {
        assert.match(e.message, /more than 12 upstream queries/);
        assert.match(e.message, /partial answer would look complete/);
        return true;
      },
    );
  });

  it("says so when a single block is too busy to serve", async () => {
    const { rpc } = upstream({ span: 1e9, cap: 5, logsPerBlock: 50 });
    await assert.rejects(
      () => getLogsWide(rpc, { fromBlock: "0x7", toBlock: "0x7" }),
      /block 7 alone returns more logs .* Add an address or topic filter/,
    );
  });

  it("caps what one query may return", async () => {
    const { rpc } = upstream({ span: 100, head: 10_000 });
    await assert.rejects(
      () => getLogsWide(rpc, { fromBlock: "0x0", toBlock: "0x3e7" }, { maxLogs: 250 }),
      /matches more than 250 logs/,
    );
  });

  it("lets a genuine error through untouched", async () => {
    const rpc = async () => {
      throw new Error("execution reverted");
    };
    await assert.rejects(() => getLogsWide(rpc, { fromBlock: "0x0", toBlock: "0x1" }), /execution reverted/);
  });

  it("hands a backwards range to the upstream and reports its answer", async () => {
    // Not ours to judge: an upstream that answers a reversed range with an
    // empty list is giving a valid answer, and we are a proxy.
    const { rpc, calls } = upstream({ span: 1000, head: 100 });
    assert.deepEqual(await getLogsWide(rpc, { fromBlock: "0x64", toBlock: "0xa" }), []);
    assert.equal(calls.length, 1);
  });

  it("does not try to halve a backwards range if the upstream refuses it", async () => {
    // Halving a range that runs backwards never terminates, so this is the one
    // case worth checking before the walk starts.
    const rpc = async (method: string) => {
      if (method === "eth_blockNumber") return "0x64";
      throw new Error(RANGE_ERR);
    };
    await assert.rejects(() => getLogsWide(rpc, { fromBlock: "0x64", toBlock: "0xa" }), /fromBlock is after toBlock/);
  });
});
