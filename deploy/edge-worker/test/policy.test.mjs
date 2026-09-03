import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCK_MS, MicroCache, cacheKey, cacheTtlMs, isPlainRead, splitBatch, staticAnswer } from "../src/policy.mjs";

test("constants of the deployment are answered without the origin", () => {
  assert.equal(staticAnswer("eth_chainId", 4663), "0x1237");
  assert.equal(staticAnswer("net_version", 4663), "4663");
  assert.equal(staticAnswer("eth_blockNumber", 4663), undefined);
});

test("cache windows mirror the gateway, with the unmined-transaction guard", () => {
  assert.equal(cacheTtlMs("eth_blockNumber", []), BLOCK_MS);
  assert.equal(cacheTtlMs("eth_gasPrice", []), 1_000);
  assert.equal(cacheTtlMs("eth_getBlockByNumber", ["latest", false]), BLOCK_MS);
  assert.equal(cacheTtlMs("eth_getBlockByNumber", ["0x10", false], { number: "0x10" }), 60_000);
  assert.equal(cacheTtlMs("eth_getBlockByNumber", ["0x10", false], null), 0, "a block that is not there yet is asked for again");
  assert.equal(cacheTtlMs("eth_getTransactionReceipt", ["0xabc"], null), 0);
  assert.equal(cacheTtlMs("eth_getTransactionReceipt", ["0xabc"], { status: "0x1" }), 600_000);
  assert.equal(cacheTtlMs("eth_getTransactionByHash", ["0xabc"], { blockNumber: null }), 0, "seen but not mined is not a fact");
  assert.equal(cacheTtlMs("eth_getTransactionByHash", ["0xabc"], { blockNumber: "0x1" }), 600_000);
  assert.equal(cacheTtlMs("eth_call", [{}], "0x"), 0, "never");
  assert.equal(cacheTtlMs("eth_getBalance", ["0x1", "latest"], "0x0"), 0, "never");
});

test("sends and ordo_* methods are never the edge's business", () => {
  assert.equal(isPlainRead("eth_sendRawTransaction"), false);
  assert.equal(isPlainRead("ordo_simulate"), false);
  assert.equal(isPlainRead("ordo_sendPrivateTransaction"), false);
  assert.equal(isPlainRead("eth_call"), true);
  assert.equal(isPlainRead(undefined), false);
});

test("a batch is split into what is answered here and what goes to the origin, order kept", () => {
  const cache = new MicroCache();
  cache.set(cacheKey("eth_blockNumber", []), "0x10", 1_000);
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x02"] },
    { jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 4, method: "eth_call", params: [{}, "latest"] },
    { jsonrpc: "2.0", id: 5, method: "eth_getTransactionReceipt", params: ["0xdead"] },
  ];
  const { answered, forward, forwardIndex } = splitBatch(batch, 4663, (k) => cache.get(k));
  assert.deepEqual(answered[0], { jsonrpc: "2.0", id: 1, result: "0x1237" });
  assert.equal(answered[1], undefined, "the send is forwarded");
  assert.deepEqual(answered[2], { jsonrpc: "2.0", id: 3, result: "0x10" }, "cached head served");
  assert.equal(answered[3], undefined, "eth_call is never cached");
  assert.equal(answered[4], undefined, "receipt miss is forwarded");
  assert.deepEqual(forward.map((m) => m.id), [2, 4, 5]);
  assert.deepEqual(forwardIndex, [1, 3, 4]);
});

test("the micro-cache expires, bounds itself and coalesces concurrent misses", async () => {
  let t = 0;
  const c = new MicroCache(2, () => t);
  c.set("a", 1, 100);
  assert.equal(c.get("a"), 1);
  t = 100;
  assert.equal(c.get("a"), undefined, "expired at the boundary");
  c.set("b", 2, 1_000);
  c.set("c", 3, 1_000);
  c.set("d", 4, 1_000);
  assert.equal(c.size, 2, "bounded");
  assert.equal(c.get("b"), undefined, "oldest evicted");

  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 10));
    return "v";
  };
  const [x, y, z] = await Promise.all([c.through("k", load, () => 1_000), c.through("k", load, () => 1_000), c.through("k", load, () => 1_000)]);
  assert.deepEqual([x, y, z], ["v", "v", "v"]);
  assert.equal(loads, 1, "one origin call for three concurrent callers");

  await assert.rejects(c.through("bad", async () => { throw new Error("no"); }, () => 1_000));
  assert.equal(c.get("bad"), undefined, "a failure is cached by nobody");
});
