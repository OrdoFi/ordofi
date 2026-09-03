import { test } from "node:test";
import assert from "node:assert/strict";
import { callOrigin, forwardHeaders } from "../src/edge.ts";

test("forwarded headers carry the key, the client's address and nothing else", () => {
  const h = forwardHeaders(
    { "x-api-key": "ordo_abc", "cf-connecting-ip": "203.0.113.9", "user-agent": "MetaMask/12", host: "edge", "content-length": "44", cookie: "x=y" },
    "198.51.100.7",
  );
  assert.deepEqual(h, {
    "content-type": "application/json",
    "x-api-key": "ordo_abc",
    "cf-connecting-ip": "203.0.113.9",
    "user-agent": "MetaMask/12",
  });
});

test("an edge reached directly names the client it saw", () => {
  const h = forwardHeaders({}, "198.51.100.7");
  assert.equal(h["cf-connecting-ip"], "198.51.100.7");
  assert.equal(forwardHeaders({}, "unknown")["cf-connecting-ip"], undefined);
});

test("the origin's result comes back as it was", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0x10" }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await callOrigin("https://origin.test", "eth_blockNumber", [], 7, { "x-api-key": "k" }, fetchImpl);
  assert.deepEqual(r, { result: "0x10" });
  assert.equal(seen[0].url, "https://origin.test");
  assert.equal((seen[0].init.headers as Record<string, string>)["x-api-key"], "k");
  assert.deepEqual(JSON.parse(seen[0].init.body as string), { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] });
});

test("the origin's error comes back with its code and data", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "ordo: transaction would revert", data: { ordoProtected: true } } }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const r = await callOrigin("https://origin.test", "eth_sendRawTransaction", ["0x02"], 1, {}, fetchImpl);
  assert.deepEqual(r, { error: { code: -32000, message: "ordo: transaction would revert", data: { ordoProtected: true } } });
});

test("an unreachable origin is a -32000, never a retry", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await callOrigin("https://origin.test", "eth_sendRawTransaction", ["0x02"], 1, {}, fetchImpl);
  assert.equal(r.error?.code, -32000);
  assert.match(r.error!.message, /unreachable/);
  assert.equal(calls, 1);
});

test("a non-JSON reply from the origin is reported, not parsed as a result", async () => {
  const fetchImpl = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
  const r = await callOrigin("https://origin.test", "eth_blockNumber", [], 1, {}, fetchImpl);
  assert.equal(r.error?.code, -32000);
  assert.match(r.error!.message, /502/);
});
