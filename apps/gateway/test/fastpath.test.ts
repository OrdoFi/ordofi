import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCK_MS, IDEMPOTENT_READS, MicroCache, cacheKey, cacheTtlMs, clientIp, hedged, staticAnswer } from "../src/fastpath.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("chain id and network id are answered without an upstream", () => {
  assert.equal(staticAnswer("eth_chainId", 4663), "0x1237");
  assert.equal(staticAnswer("net_version", 4663), "4663");
  assert.equal(staticAnswer("eth_blockNumber", 4663), undefined, "the head is not a constant");
});

test("cache windows: a block for the head, a second for fees, nothing for state reads", () => {
  assert.equal(cacheTtlMs("eth_blockNumber", []), BLOCK_MS);
  assert.equal(cacheTtlMs("eth_gasPrice", []), 1_000);
  assert.equal(cacheTtlMs("eth_feeHistory", ["0x5", "latest", []]), 1_000);
  assert.equal(cacheTtlMs("eth_call", [{}, "latest"]), 0, "eth_call is never cached");
  assert.equal(cacheTtlMs("eth_getBalance", ["0xabc", "latest"]), 0);
  assert.equal(cacheTtlMs("eth_getTransactionCount", ["0xabc", "pending"]), 0, "nonces must be live");
});

test("a mined receipt is cached, a pending one is asked for again", () => {
  assert.equal(cacheTtlMs("eth_getTransactionReceipt", ["0xh"], null), 0);
  assert.ok(cacheTtlMs("eth_getTransactionReceipt", ["0xh"], { status: "0x1" }) >= 60_000);
  assert.equal(cacheTtlMs("eth_getTransactionByHash", ["0xh"], null), 0);
  assert.ok(cacheTtlMs("eth_getTransactionByHash", ["0xh"], { hash: "0xh" }) >= 60_000);
});

test("blocks: the head tag moves every block, a numbered block is immutable", () => {
  assert.equal(cacheTtlMs("eth_getBlockByNumber", ["latest", false], { number: "0x1" }), BLOCK_MS);
  assert.equal(cacheTtlMs("eth_getBlockByNumber", ["pending", false], { number: "0x1" }), BLOCK_MS);
  assert.ok(cacheTtlMs("eth_getBlockByNumber", ["0x10", false], { number: "0x10" }) >= 60_000);
  assert.equal(cacheTtlMs("eth_getBlockByNumber", ["0x10", false], null), 0, "not yet produced: ask again");
  assert.ok(cacheTtlMs("eth_getBlockByHash", ["0xb", false], { number: "0x10" }) >= 60_000);
});

test("the cache key distinguishes params, so a receipt for one hash never answers for another", () => {
  assert.notEqual(cacheKey("eth_getTransactionReceipt", ["0xa"]), cacheKey("eth_getTransactionReceipt", ["0xb"]));
  assert.equal(cacheKey("eth_blockNumber", []), cacheKey("eth_blockNumber", undefined as unknown as unknown[]));
});

test("sends are not idempotent reads", () => {
  assert.ok(!IDEMPOTENT_READS.has("eth_sendRawTransaction"));
  assert.ok(!IDEMPOTENT_READS.has("ordo_sendBundle"));
  assert.ok(IDEMPOTENT_READS.has("eth_call"));
});

test("micro-cache: entries expire on their own clock", () => {
  let now = 1_000;
  const c = new MicroCache(10, () => now);
  c.set("k", "v", 100);
  assert.equal(c.get("k"), "v");
  now += 99;
  assert.equal(c.get("k"), "v");
  now += 1;
  assert.equal(c.get("k"), undefined, "gone at exactly the TTL");
  c.set("never", "v", 0);
  assert.equal(c.get("never"), undefined, "ttl 0 stores nothing");
});

test("micro-cache is bounded: the oldest entry makes room", () => {
  const c = new MicroCache(2, () => 0);
  c.set("a", 1, 1000);
  c.set("b", 2, 1000);
  c.set("c", 3, 1000);
  assert.equal(c.size, 2);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("c"), 3);
});

test("coalescing: ten concurrent identical reads cost one upstream call", async () => {
  const c = new MicroCache();
  let calls = 0;
  const load = async () => {
    calls++;
    await sleep(20);
    return "0x10";
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => c.through("eth_blockNumber:[]", load, () => 0)));
  assert.deepEqual(results, Array(10).fill("0x10"));
  assert.equal(calls, 1);
  // ttl 0: nothing was kept, the next caller pays again.
  await c.through("eth_blockNumber:[]", load, () => 0);
  assert.equal(calls, 2);
});

test("coalescing: a failure is shared with every waiter and cached by nobody", async () => {
  const c = new MicroCache();
  let calls = 0;
  const load = async () => {
    calls++;
    await sleep(5);
    throw new Error("upstream down");
  };
  const settled = await Promise.allSettled([c.through("k", load, () => 1000), c.through("k", load, () => 1000)]);
  assert.equal(calls, 1);
  assert.ok(settled.every((s) => s.status === "rejected"));
  assert.equal(c.get("k"), undefined);
  await assert.rejects(c.through("k", load, () => 1000));
  assert.equal(calls, 2, "retried, not served a cached failure");
});

test("through(): the ttl is decided by the result, so a null receipt is not kept", async () => {
  const c = new MicroCache();
  const ttl = (r: unknown) => cacheTtlMs("eth_getTransactionReceipt", ["0xh"], r);
  await c.through("r", async () => null, ttl);
  assert.equal(c.get("r"), undefined);
  await c.through("r", async () => ({ status: "0x1" }), ttl);
  assert.deepEqual(c.get("r"), { status: "0x1" });
});

test("hedge: a fast primary never fires the hedge", async () => {
  const events: string[] = [];
  let hedgeCalls = 0;
  const v = await hedged(
    async () => "primary",
    async () => {
      hedgeCalls++;
      return "hedge";
    },
    50,
    (e) => events.push(e),
  );
  await sleep(70);
  assert.equal(v, "primary");
  assert.equal(hedgeCalls, 0);
  assert.deepEqual(events, []);
});

test("hedge: a slow primary is overtaken by the hedge, and the first answer wins", async () => {
  const events: string[] = [];
  const started = Date.now();
  const v = await hedged(
    () => sleep(300).then(() => "primary"),
    () => sleep(10).then(() => "hedge"),
    30,
    (e) => events.push(e),
  );
  assert.equal(v, "hedge");
  assert.ok(Date.now() - started < 200, "did not wait for the slow primary");
  assert.deepEqual(events, ["fired", "won"]);
});

test("hedge: a slow-but-first primary still wins when the hedge is slower", async () => {
  const v = await hedged(
    () => sleep(60).then(() => "primary"),
    () => sleep(200).then(() => "hedge"),
    30,
  );
  assert.equal(v, "primary");
});

test("hedge: a failing primary is rescued by the hedge", async () => {
  const v = await hedged(
    () => sleep(40).then(() => Promise.reject(new Error("primary 502"))),
    () => sleep(10).then(() => "hedge"),
    20,
  );
  assert.equal(v, "hedge");
});

test("hedge: a fast failure before the hedge fires is reported at once, and the hedge never starts", async () => {
  let hedgeCalls = 0;
  await assert.rejects(
    hedged(
      async () => {
        throw new Error("bad request");
      },
      async () => {
        hedgeCalls++;
        return "hedge";
      },
      50,
    ),
    /bad request/,
  );
  await sleep(70);
  assert.equal(hedgeCalls, 0);
});

test("hedge: when both fail, the primary's error is the one the caller sees", async () => {
  await assert.rejects(
    hedged(
      () => sleep(30).then(() => Promise.reject(new Error("primary failed"))),
      () => sleep(30).then(() => Promise.reject(new Error("hedge failed"))),
      10,
    ),
    /primary failed/,
  );
});

test("the anonymous limit is keyed on the wallet, not the proxy in front of it", () => {
  const sock = { remoteAddress: "172.18.0.5" };
  assert.equal(clientIp({ headers: {}, socket: sock }), "172.18.0.5", "no proxy: the peer");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "203.0.113.9" }, socket: sock }), "203.0.113.9", "Caddy alone: the hop it recorded");
  assert.equal(
    clientIp({ headers: { "x-forwarded-for": "104.23.199.123", "cf-connecting-ip": "203.0.113.9" }, socket: sock }),
    "203.0.113.9",
    "Cloudflare in front: its header names the wallet, x-forwarded-for names the edge",
  );
  assert.equal(
    clientIp({ headers: { "x-forwarded-for": "198.51.100.7, 104.23.199.123", "cf-connecting-ip": "203.0.113.9" }, socket: sock }),
    "203.0.113.9",
    "a client-supplied x-forwarded-for prefix cannot pick its own key",
  );
});

test("the in-flight cap serializes one client's excess and refuses only a client that keeps it full", async () => {
  const { InflightCap } = await import("../src/fastpath.ts");
  const cap = new InflightCap(2, 200);
  const a = await cap.acquire("ip");
  const b = await cap.acquire("ip");
  assert.ok(a && b);
  assert.equal(cap.inflight("ip"), 2);
  let thirdGot: unknown = "pending";
  const third = cap.acquire("ip").then((r) => (thirdGot = r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(thirdGot, "pending", "waits rather than refuses");
  assert.equal(cap.waiting("ip"), 1);
  a!();
  await third;
  assert.ok(typeof thirdGot === "function", "handed the freed slot");
  assert.equal(cap.inflight("ip"), 2, "count never exceeds the cap");
  // Another client is unaffected.
  assert.ok(await cap.acquire("other"));
  // A client that keeps the cap full past the wait is refused.
  const fourth = await cap.acquire("ip");
  assert.equal(fourth, null);
  b!();
  (thirdGot as () => void)();
  assert.equal(cap.inflight("ip"), 0);
});

test("the hedge budget lets quiet periods hedge and stops a flood from doubling itself", async () => {
  const { HedgeBudget } = await import("../src/fastpath.ts");
  let t = 0;
  const budget = new HedgeBudget(0.1, 5, 10_000, () => t);
  // Quiet: a handful of slow reads may all hedge (the floor).
  for (let i = 0; i < 5; i++) budget.read();
  for (let i = 0; i < 5; i++) assert.equal(budget.tryHedge(), true);
  assert.equal(budget.tryHedge(), false, "sixth of five reads: over the ratio and past the floor");
  // Busy: 1,000 reads allow ~100 hedges, not 1,000.
  for (let i = 0; i < 1000; i++) budget.read();
  let fired = 0;
  for (let i = 0; i < 1000; i++) if (budget.tryHedge()) fired++;
  assert.ok(fired >= 90 && fired <= 101, `fired ${fired}`);
  // The window rolls: 11 s later the past is forgotten.
  t = 11_000;
  budget.read();
  assert.equal(budget.tryHedge(), true);
});

test("a withheld hedge leaves the primary on its own, success or failure", async () => {
  const { hedged } = await import("../src/fastpath.ts");
  const events: string[] = [];
  const slow = () => new Promise<string>((r) => setTimeout(() => r("primary"), 40));
  const v = await hedged(slow, async () => "hedge", 5, (e) => events.push(e), () => false);
  assert.equal(v, "primary");
  assert.deepEqual(events, ["withheld"]);
  await assert.rejects(
    hedged(() => new Promise((_, rej) => setTimeout(() => rej(new Error("down")), 30)), async () => "hedge", 5, undefined, () => false),
    /down/,
  );
});
