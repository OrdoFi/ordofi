import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HeadWatcher, Hub, logMatches, parseLogFilter, toHeader, type RawLog } from "../src/subscribe.ts";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const T0 = "0x" + "11".repeat(32);
const T1 = "0x" + "22".repeat(32);
const T2 = "0x" + "33".repeat(32);

const log = (address: string, topics: string[]): RawLog => ({ address, topics });

/** A sink that records what was pushed to it. */
function sink() {
  const got: any[] = [];
  return { send: (p: string) => got.push(JSON.parse(p)), got };
}

describe("log filters", () => {
  it("matches everything when nothing is asked for", () => {
    const f = parseLogFilter({});
    assert.equal(logMatches(log(A, [T0]), f), true);
    assert.equal(logMatches(log(B, []), f), true);
  });

  it("takes one address or several, in any case", () => {
    assert.equal(logMatches(log(A, []), parseLogFilter({ address: A.toUpperCase() })), true);
    assert.equal(logMatches(log(B, []), parseLogFilter({ address: A })), false);
    assert.equal(logMatches(log(B, []), parseLogFilter({ address: [A, B] })), true);
  });

  it("reads topics by position, with null meaning anything", () => {
    // [T0, null, T2]: first and third pinned, second free.
    const f = parseLogFilter({ topics: [T0, null, T2] });
    assert.equal(logMatches(log(A, [T0, T1, T2]), f), true);
    assert.equal(logMatches(log(A, [T0, T2, T2]), f), true, "the free position takes anything");
    assert.equal(logMatches(log(A, [T1, T1, T2]), f), false, "wrong event");
    assert.equal(logMatches(log(A, [T0, T1]), f), false, "a constrained position the log does not have is a miss");
  });

  it("treats a list in one position as or", () => {
    const f = parseLogFilter({ topics: [[T0, T1]] });
    assert.equal(logMatches(log(A, [T1]), f), true);
    assert.equal(logMatches(log(A, [T2]), f), false);
  });

  it("ignores a filter it cannot read rather than refusing to subscribe", () => {
    const f = parseLogFilter({ address: 42, topics: "nonsense" });
    assert.equal(f.address, null);
    assert.deepEqual(f.topics, []);
    assert.equal(logMatches(log(A, [T0]), f), true);
  });
});

describe("the hub", () => {
  it("gives each subscription an unguessable id and pushes heads to head subscribers only", () => {
    const hub = new Hub();
    const heads = sink(), logs = sink();
    const id = hub.add(heads, "newHeads", null);
    hub.add(logs, "logs", parseLogFilter({}));
    assert.match(id, /^0x[0-9a-f]{32}$/);

    hub.pushHead({ number: "0x1" });
    assert.equal(heads.got.length, 1);
    assert.equal(logs.got.length, 0, "a logs subscriber is not a heads subscriber");
    assert.deepEqual(heads.got[0], {
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: id, result: { number: "0x1" } },
    });
  });

  it("delivers a log once per matching subscription, and not to the others", () => {
    const hub = new Hub();
    const mine = sink(), theirs = sink();
    hub.add(mine, "logs", parseLogFilter({ address: A }));
    hub.add(theirs, "logs", parseLogFilter({ address: B }));
    hub.pushLogs([log(A, [T0]), log(B, [T0]), log(A, [T1])]);
    assert.equal(mine.got.length, 2);
    assert.equal(theirs.got.length, 1);
  });

  it("lets a connection cancel only its own subscriptions", () => {
    const hub = new Hub();
    const one = sink(), two = sink();
    const id = hub.add(one, "newHeads", null);
    assert.equal(hub.remove(two, id), false, "another socket may not cancel it");
    assert.equal(hub.remove(one, id), true);
    assert.equal(hub.remove(one, id), false, "and not twice");
    hub.pushHead({ number: "0x1" });
    assert.equal(one.got.length, 0);
  });

  it("forgets everything a closed socket held", () => {
    const hub = new Hub();
    const s = sink();
    hub.add(s, "newHeads", null);
    hub.add(s, "logs", parseLogFilter({}));
    assert.equal(hub.countOf(s), 2);
    assert.equal(hub.drop(s), 2);
    assert.equal(hub.size, 0);
    assert.equal(hub.wantsHeads, false);
    assert.equal(hub.wantsLogs, false);
  });

  it("knows whether anything needs the poller running", () => {
    const hub = new Hub();
    const s = sink();
    assert.equal(hub.wantsHeads || hub.wantsLogs, false);
    const id = hub.add(s, "logs", parseLogFilter({}));
    assert.equal(hub.wantsLogs, true);
    assert.equal(hub.wantsHeads, false, "logs alone must not claim heads");
    hub.remove(s, id);
    assert.equal(hub.wantsLogs, false);
  });
});

describe("the head watcher", () => {
  const block = (n: number) => ({
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    parentHash: "0x0",
    transactions: ["0xdead"],
    uncles: [],
  });

  /** An upstream that answers from a fixed head, recording what was asked. */
  function rpcAt(head: () => number, logsByHash: Record<string, RawLog[]> = {}) {
    const calls: string[] = [];
    const rpc = async (method: string, params: unknown[]) => {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === "eth_getBlockByNumber") {
        const tag = params[0] as string;
        return block(tag === "latest" ? head() : Number(tag));
      }
      if (method === "eth_getLogs") {
        const q = params[0] as { blockHash?: string; fromBlock?: string; toBlock?: string };
        if (q.blockHash) return logsByHash[q.blockHash] ?? [];
        // A range covers every block in it.
        const out: RawLog[] = [];
        for (let b = Number(q.fromBlock); b <= Number(q.toBlock); b++) out.push(...(logsByHash[block(b).hash] ?? []));
        return out;
      }
      throw new Error(`unexpected ${method}`);
    };
    return { rpc, calls };
  }

  function watcher(rpc: any, over: Partial<Parameters<typeof HeadWatcher.prototype.tick>> = {}) {
    const heads: any[] = [];
    const logs: RawLog[] = [];
    let wantsLogs = false;
    const w = new HeadWatcher(rpc, {
      intervalMs: 10_000, // never fires on its own; the tests drive tick()
      maxCatchUp: 4,
      onHead: (h) => heads.push(h),
      onLogs: (l) => logs.push(...l),
      wantsLogs: () => wantsLogs,
      onError: (e) => {
        throw e;
      },
      ...(over as object),
    });
    return { w, heads, logs, setWantsLogs: (v: boolean) => (wantsLogs = v) };
  }

  it("starts at the head and does not replay history", async () => {
    let head = 100;
    const { rpc } = rpcAt(() => head);
    const { w, heads } = watcher(rpc);
    await w.tick();
    assert.deepEqual(heads.map((h) => h.number), ["0x64"], "one block, not a hundred");
  });

  it("fills in blocks a late tick stepped over", async () => {
    let head = 100;
    const { rpc } = rpcAt(() => head);
    const { w, heads } = watcher(rpc);
    await w.tick();
    head = 103;
    await w.tick();
    assert.deepEqual(heads.map((h) => Number(h.number)), [100, 101, 102, 103], "a subscriber is owed every block");
  });

  it("gives up and jumps when it falls too far behind", async () => {
    let head = 100;
    const { rpc } = rpcAt(() => head);
    const { w, heads } = watcher(rpc);
    await w.tick();
    head = 1_000; // 900 blocks; maxCatchUp is 4
    await w.tick();
    assert.deepEqual(heads.map((h) => Number(h.number)), [100, 997, 998, 999, 1000]);
  });

  it("says nothing when the head has not moved", async () => {
    const { rpc } = rpcAt(() => 100);
    const { w, heads } = watcher(rpc);
    await w.tick();
    await w.tick();
    await w.tick();
    assert.equal(heads.length, 1);
  });

  it("sends the header, not the block", async () => {
    const { rpc } = rpcAt(() => 7);
    const { w, heads } = watcher(rpc);
    await w.tick();
    assert.equal("transactions" in heads[0], false, "a few hundred hashes nobody reads, ten times a second");
    assert.equal("uncles" in heads[0], false);
    assert.equal(heads[0].parentHash, "0x0");
  });

  it("does not touch eth_getLogs when nobody is subscribed to them", async () => {
    const { rpc, calls } = rpcAt(() => 5);
    const { w } = watcher(rpc);
    await w.tick();
    await w.settled;
    assert.equal(calls.filter((c) => c.startsWith("eth_getLogs")).length, 0);
  });

  it("asks for the whole advanced range at once, not once per block", async () => {
    // Per-block requests cost a round trip each, and eth_getLogs is the
    // slowest call we make; three blocks of catch-up used to mean three of them.
    let head = 100;
    const { rpc, calls } = rpcAt(() => head, {
      [block(102).hash]: [log(A, [T0])],
      [block(104).hash]: [log(B, [T1])],
    });
    const { w, logs, setWantsLogs } = watcher(rpc);
    setWantsLogs(true);
    await w.tick();
    await w.settled;
    head = 104;
    await w.tick();
    await w.settled;
    const asks = calls.filter((c) => c.startsWith("eth_getLogs"));
    assert.equal(asks.length, 2, "one per tick, however many blocks it covered");
    assert.ok(asks[1].includes('"fromBlock":"0x65"') && asks[1].includes('"toBlock":"0x68"'), asks[1]);
    assert.ok(logs.length > 0);
  });

  it("does not make the head wait for the logs", async () => {
    // The heads must be on the wire before the log request has even resolved.
    let releaseLogs: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseLogs = r));
    const rpc = async (method: string, params: unknown[]) => {
      if (method === "eth_getLogs") {
        await gate;
        return [log(A, [T0])];
      }
      return block(parseInt(String((params as any[])[0]) === "latest" ? "7" : String((params as any[])[0]), 16) || 7);
    };
    const { w, heads, logs, setWantsLogs } = watcher(rpc);
    setWantsLogs(true);
    await w.tick();
    assert.equal(heads.length, 1, "the head went out");
    assert.equal(logs.length, 0, "while the logs are still in flight");
    releaseLogs();
    await w.settled;
    assert.equal(logs.length, 1, "and arrive after");
  });

  it("does not let a slow tick queue behind itself", async () => {
    let inFlight = 0, overlaps = 0;
    const rpc = async () => {
      inFlight++;
      if (inFlight > 1) overlaps++;
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return block(1);
    };
    const { w } = watcher(rpc);
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    assert.equal(overlaps, 0);
  });

  it("reports an upstream failure instead of throwing into the interval", async () => {
    const errors: Error[] = [];
    const rpc = async () => {
      throw new Error("upstream down");
    };
    const { w } = watcher(rpc, { onError: (e: Error) => errors.push(e) } as any);
    await w.tick();
    assert.deepEqual(errors.map((e) => e.message), ["upstream down"]);
  });

  it("forgets where it was when it stops, so a new subscriber gets the head", async () => {
    let head = 100;
    const { rpc } = rpcAt(() => head);
    const { w, heads } = watcher(rpc);
    await w.tick();
    w.stop();
    head = 500;
    await w.tick();
    assert.deepEqual(heads.map((h) => Number(h.number)), [100, 500], "not 400 blocks of catch-up nobody asked for");
  });
});

describe("toHeader", () => {
  it("keeps the header fields a client actually reads", () => {
    const h = toHeader({ number: "0x1", hash: "0xabc", parentHash: "0xdef", gasUsed: "0x5", transactions: ["0x1"] });
    assert.deepEqual(h, { number: "0x1", hash: "0xabc", parentHash: "0xdef", gasUsed: "0x5" });
  });
});
