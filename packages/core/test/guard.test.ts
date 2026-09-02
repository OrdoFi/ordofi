/**
 * The delivery proof is what stands between an encoder mistake and a wallet.
 * These tests drive it with a fake eth_simulateV1 so every way it must say
 * "no" is pinned: money to a black hole, less than promised, more than quoted,
 * left behind in the router, a revert, and no simulator at all.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { BALANCE_READER, BLACKHOLES, proveDelivery, proofToJson } from "../src/guard.ts";

const FROM = "0x76a7bd1b8527662bcdbe2981049d052ed3b6ddc5";
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ADDR1 = BLACKHOLES[1];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const key = (holder: string, asset: string) => `${holder.toLowerCase()}:${asset.toLowerCase()}`;

type World = Record<string, bigint>;

/**
 * Answers eth_simulateV1 by reading balances from `before` for every read that
 * precedes the transaction and from `after` for every read that follows it.
 */
function fakeSimulator(opts: { before: World; after: World; txStatus?: string; txLogs?: any[]; txError?: string; approvalStatus?: string }) {
  const seen: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), body });
    const calls: any[] = body.params[0].blockStateCalls[0].calls;
    const txIndex = calls.findIndex((c) => c.from && c.to.toLowerCase() === ROUTER);
    const results = calls.map((c, i) => {
      if (i === txIndex) {
        return { status: opts.txStatus ?? "0x1", gasUsed: "0x1e848", logs: opts.txLogs ?? [], ...(opts.txError ? { error: { message: opts.txError } } : {}) };
      }
      if (c.from) return { status: opts.approvalStatus ?? "0x1", gasUsed: "0x5208", logs: [] }; // the approval
      const world = i < txIndex ? opts.before : opts.after;
      let holder: string, asset: string;
      if (c.to.toLowerCase() === BALANCE_READER) { holder = "0x" + c.data.slice(-40); asset = "eth"; }
      else { holder = "0x" + c.data.slice(-40); asset = c.to; }
      return { status: "0x1", gasUsed: "0x0", returnData: word(world[key(holder, asset)] ?? 0n), logs: [] };
    });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ calls: results }] }));
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const swap = {
  from: FROM as `0x${string}`,
  tx: { to: ROUTER as `0x${string}`, data: "0x5ae401dc" as `0x${string}` },
  approval: { token: USDG as `0x${string}`, spender: ROUTER as `0x${string}`, amount: 900_000_000n },
  expect: [{ asset: "eth" as const, min: 370n * 10n ** 15n }],
  pay: [{ asset: USDG as `0x${string}`, max: 900_000_000n }],
  mustNotRetain: [{ holder: ROUTER as `0x${string}`, asset: WETH as `0x${string}` }],
};
const urls = ["https://sim.test"];

test("a swap that pays the trader is proven, and the request has the right shape", async () => {
  const before: World = { [key(FROM, "eth")]: 10n ** 18n, [key(FROM, USDG)]: 1_000_000_000n, [key(ADDR1, "eth")]: 5n };
  const after: World = { ...before, [key(FROM, "eth")]: 10n ** 18n + 376n * 10n ** 15n, [key(FROM, USDG)]: 100_000_000n };
  const sim = fakeSimulator({ before, after });
  const p = await proveDelivery(swap, { urls, fetchImpl: sim.fetchImpl });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.received[0].amount, 376n * 10n ** 15n);
  assert.equal(p.paid[0].amount, 900_000_000n);
  assert.deepEqual(p.leaks, []);
  assert.equal(p.via, "sim.test");

  const req = sim.seen[0].body;
  assert.equal(req.method, "eth_simulateV1");
  const block = req.params[0].blockStateCalls[0];
  assert.equal(req.params[0].validation, false);
  assert.ok(block.stateOverrides[BALANCE_READER].code.startsWith("0x60"));
  assert.ok(block.stateOverrides[FROM].balance);
  const calls = block.calls;
  const txIndex = calls.findIndex((c: any) => c.from && c.to.toLowerCase() === ROUTER);
  assert.equal(calls[txIndex - 1].to, USDG, "approval simulated right before the swap");
  assert.ok(calls[txIndex - 1].data.startsWith("0x095ea7b3"));
  assert.equal(calls[txIndex].from, FROM);
  const reads = txIndex - 1; // everything before the approval is a balance read
  assert.equal(calls.length, reads + 1 + 1 + reads, "every balance read before is repeated after");
  // Every black hole's ETH balance is watched.
  for (const hole of BLACKHOLES) assert.ok(calls.some((c: any) => c.to === BALANCE_READER && c.data.endsWith(hole.slice(2))), hole);

  const json = proofToJson(p);
  assert.equal(json.ok, true);
  assert.equal(json.received[0].amount, (376n * 10n ** 15n).toString());
});

test("ETH landing on address(1) is a loss even though the transaction succeeded", async () => {
  const before: World = { [key(FROM, "eth")]: 10n ** 18n, [key(FROM, USDG)]: 1_000_000_000n, [key(ADDR1, "eth")]: 4n * 10n ** 18n };
  const after: World = { ...before, [key(FROM, USDG)]: 100_000_000n, [key(ADDR1, "eth")]: 4n * 10n ** 18n + 376n * 10n ** 15n };
  const p = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after }).fetchImpl });
  assert.equal(p.ok, false);
  assert.match(p.reason!, /funds would be lost/);
  assert.deepEqual(p.leaks, [{ to: ADDR1, asset: "eth", amount: 376n * 10n ** 15n }]);
  assert.equal(p.received[0].amount, 0n);
});

test("tokens transferred to a black hole are a loss; WETH burns to address(0) are not", async () => {
  const before: World = { [key(FROM, "eth")]: 10n ** 18n, [key(FROM, USDG)]: 1_000_000_000n };
  const after: World = { ...before, [key(FROM, "eth")]: 10n ** 18n + 376n * 10n ** 15n, [key(FROM, USDG)]: 100_000_000n };
  const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const burn = { address: WETH, topics: [TRANSFER, pad(ROUTER), pad(BLACKHOLES[0])], data: word(376n * 10n ** 15n) };
  const fine = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after, txLogs: [burn] }).fetchImpl });
  assert.equal(fine.ok, true, fine.reason);

  const toTwo = { address: USDG, topics: [TRANSFER, pad(ROUTER), pad(BLACKHOLES[2])], data: word(5n) };
  const bad = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after, txLogs: [burn, toTwo] }).fetchImpl });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.leaks, [{ to: BLACKHOLES[2], asset: USDG, amount: 5n }]);
});

test("less than the promised minimum is refused", async () => {
  const before: World = { [key(FROM, "eth")]: 10n ** 18n, [key(FROM, USDG)]: 1_000_000_000n };
  const after: World = { ...before, [key(FROM, "eth")]: 10n ** 18n + 369n * 10n ** 15n, [key(FROM, USDG)]: 100_000_000n };
  const p = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after }).fetchImpl });
  assert.equal(p.ok, false);
  assert.match(p.reason!, /less than the promised/);
});

test("paying more than quoted is refused", async () => {
  const before: World = { [key(FROM, "eth")]: 10n ** 18n, [key(FROM, USDG)]: 1_000_000_000n };
  const after: World = { ...before, [key(FROM, "eth")]: 10n ** 18n + 376n * 10n ** 15n, [key(FROM, USDG)]: 0n };
  const p = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after }).fetchImpl });
  assert.equal(p.ok, false);
  assert.match(p.reason!, /more than the quoted/);
});

test("output left inside the router is refused", async () => {
  const before: World = { [key(FROM, "eth")]: 10n ** 18n, [key(FROM, USDG)]: 1_000_000_000n, [key(ROUTER, WETH)]: 0n };
  const after: World = { ...before, [key(FROM, "eth")]: 10n ** 18n + 376n * 10n ** 15n, [key(FROM, USDG)]: 100_000_000n, [key(ROUTER, WETH)]: 7n };
  const p = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after }).fetchImpl });
  assert.equal(p.ok, false);
  assert.match(p.reason!, /stuck/);
  assert.deepEqual(p.retained, [{ to: ROUTER, asset: WETH, amount: 7n }]);
});

test("a revert is reported with its reason, and a failed approval too", async () => {
  const before: World = {}; const after: World = {};
  const p = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after, txStatus: "0x0", txError: "execution reverted: STF" }).fetchImpl });
  assert.equal(p.ok, false);
  assert.match(p.reason!, /would revert: execution reverted: STF/);
  assert.equal(p.reverted, "execution reverted: STF");

  const q = await proveDelivery(swap, { urls, fetchImpl: fakeSimulator({ before, after, approvalStatus: "0x0" }).fetchImpl });
  assert.equal(q.ok, false);
  assert.match(q.reason!, /approval would revert/);
});

test("with no simulator anywhere the answer is 'not proven', never 'ok'", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }));
  }) as typeof fetch;
  const p = await proveDelivery(swap, { urls: ["https://a.test", "https://b.test"], fetchImpl });
  assert.equal(p.ok, false);
  assert.equal(p.unavailable, true);
  assert.match(p.reason!, /cannot verify/);
  assert.ok(attempts >= 4, "tried the configured upstreams and the public fallbacks");
});

test("an upstream that refuses is skipped in favour of one that answers", async () => {
  const before: World = { [key(FROM, "eth")]: 0n, [key(FROM, USDG)]: 1_000_000_000n };
  const after: World = { ...before, [key(FROM, "eth")]: 376n * 10n ** 15n, [key(FROM, USDG)]: 100_000_000n };
  const good = fakeSimulator({ before, after });
  const fetchImpl = (async (url: any, init: any) => {
    if (String(url).includes("gateway")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "unauthorized" } }));
    return good.fetchImpl(url, init);
  }) as typeof fetch;
  const p = await proveDelivery(swap, { urls: ["https://gateway.test", "https://sim.test"], fetchImpl });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.via, "sim.test");
});
