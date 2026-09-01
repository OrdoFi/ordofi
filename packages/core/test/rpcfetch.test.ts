/**
 * Failover behaviour, which is what keeps the watcher indexing while one
 * upstream is busy refusing it. The subtle case is rate limiting: it arrives
 * as a JSON-RPC error rather than a transport failure, so the obvious rule
 * ("RPC errors are real answers, don't retry elsewhere") gets it backwards.
 */
import { strict as assert } from "node:assert";
import test, { afterEach, beforeEach } from "node:test";

const A = "https://a.example";
const B = "https://b.example";

let calls: string[] = [];
const realFetch = globalThis.fetch;

/** Each entry is what that host should reply with on its next call. */
function stub(handlers: Record<string, () => { status?: number; body: unknown } | string>) {
  globalThis.fetch = (async (url: string) => {
    const host = new URL(url).origin;
    calls.push(host);
    const out = handlers[host]();
    if (typeof out === "string") return new Response(out, { status: 403 }); // challenge page
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const ok = (result: unknown) => () => ({ body: { jsonrpc: "2.0", id: 1, result } });
const rpcError = (message: string, code = -32000) => () => ({
  body: { jsonrpc: "2.0", id: 1, error: { code, message } },
});

beforeEach(() => {
  calls = [];
  process.env.ORDO_RPC_URLS = `${A},${B}`;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ORDO_RPC_URLS;
});

async function freshRpcFetch() {
  // Module-level cursor state has to be reset between cases.
  const mod = await import(`../src/index.ts?case=${Math.random()}`);
  return mod;
}

test("a rate limit fails over instead of giving up", async () => {
  const { rpcFetch } = await freshRpcFetch();
  stub({ [A]: rpcError("Too Many Requests", -32005), [B]: ok("0x1") });

  assert.equal(await rpcFetch("eth_blockNumber", []), "0x1");
  assert.deepEqual(calls, [A, B], "should have tried the throttled host, then the other");
});

test("a rate limit does not make the throttled upstream sticky", async () => {
  const { rpcFetch } = await freshRpcFetch();
  stub({ [A]: rpcError("rate limit exceeded"), [B]: ok("0x2") });

  await rpcFetch("eth_blockNumber", []);
  calls = [];
  await rpcFetch("eth_blockNumber", []);

  assert.equal(calls[0], B, "the second call should start at the host that answered");
});

test("a real RPC error is not retried elsewhere", async () => {
  const { rpcFetch } = await freshRpcFetch();
  stub({ [A]: rpcError("intrinsic gas too low"), [B]: ok("0x3") });

  await assert.rejects(rpcFetch("eth_sendRawTransaction", ["0x"]), /intrinsic gas too low/);
  assert.deepEqual(calls, [A], "asking a second node would just get the same answer");
});

test("a bot-challenge page fails over", async () => {
  const { rpcFetch } = await freshRpcFetch();
  stub({ [A]: () => "<html>attention required</html>", [B]: ok("0x4") });

  assert.equal(await rpcFetch("eth_blockNumber", []), "0x4");
  assert.deepEqual(calls, [A, B]);
});

test("every upstream throttled surfaces the last error", async () => {
  const { rpcFetch } = await freshRpcFetch();
  stub({ [A]: rpcError("Too Many Requests"), [B]: rpcError("Too Many Requests") });

  await assert.rejects(rpcFetch("eth_blockNumber", []), /Too Many Requests/);
  assert.deepEqual(calls, [A, B]);
});

test("isRetryableRpcError recognises throttling but not real failures", async () => {
  const { isRetryableRpcError } = await freshRpcFetch();

  assert.equal(isRetryableRpcError({ message: "Too Many Requests" }), true);
  assert.equal(isRetryableRpcError({ message: "rate limit exceeded" }), true);
  assert.equal(isRetryableRpcError({ code: -32005, message: "limit" }), true);
  assert.equal(isRetryableRpcError({ message: "over capacity, try again" }), true);

  assert.equal(isRetryableRpcError({ message: "execution reverted" }), false);
  assert.equal(isRetryableRpcError({ message: "nonce too low" }), false);
  assert.equal(isRetryableRpcError({ code: -32000, message: "intrinsic gas too low" }), false);
});

test("a host without the history fails over to one that keeps it", async () => {
  const { rpcFetch } = await freshRpcFetch();
  stub({
    [A]: rpcError("Archive requests require a personal token. Get one at: https://example"),
    [B]: ok([]),
  });

  assert.deepEqual(await rpcFetch("eth_getLogs", [{}]), []);
  assert.deepEqual(calls, [A, B], "a retention policy is not an answer about the chain");
});

test("sendRawTransaction: the sequencer's own answer is final, transport failure falls back visibly", async () => {
  const { sendRawTransaction } = await import("../src/index.ts");
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  process.env.ORDO_SEQUENCER_URL = "https://sequencer.test";
  process.env.ORDO_RPC_URLS = "https://provider-a.test,https://provider-b.test";
  try {
    // 1. sequencer answers with a real RPC error → thrown as-is, no fallback
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nonce too low" } }));
    }) as any;
    await assert.rejects(sendRawTransaction("0x01"), /nonce too low/);
    assert.deepEqual(calls, ["https://sequencer.test"], "a definitive answer never reaches a third party");

    // 2. sequencer unreachable → fallback to the provider list, and the caller is told
    calls.length = 0;
    let fallbackReason = "";
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes("sequencer")) return new Response("<html>cloudflare</html>", { status: 403 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xhash" }));
    }) as any;
    const hash = await sendRawTransaction("0x01", { onFallback: (r) => (fallbackReason = r) });
    assert.equal(hash, "0xhash");
    assert.match(fallbackReason, /403/);
    assert.equal(calls[0], "https://sequencer.test");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ORDO_SEQUENCER_URL;
    delete process.env.ORDO_RPC_URLS;
  }
});
