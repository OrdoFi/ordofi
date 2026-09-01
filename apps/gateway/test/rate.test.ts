import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/config.ts";

test("fixed-window rate limiter blocks over the limit", () => {
  const rl = new RateLimiter();
  assert.equal(rl.check("k", 2).ok, true);
  assert.equal(rl.check("k", 2).ok, true);
  const third = rl.check("k", 2);
  assert.equal(third.ok, false, "third request in window blocked");
  assert.ok(third.retryAfterMs > 0);
});

test("limit 0 means unlimited", () => {
  const rl = new RateLimiter();
  for (let i = 0; i < 100; i++) assert.equal(rl.check("k", 0).ok, true);
});

test("separate keys have separate windows", () => {
  const rl = new RateLimiter();
  assert.equal(rl.check("a", 1).ok, true);
  assert.equal(rl.check("a", 1).ok, false);
  assert.equal(rl.check("b", 1).ok, true, "different key unaffected");
});

test("anonymous tier covers what a wallet needs, including a protected send", async () => {
  const { CONFIG } = await import("../src/config.ts");
  for (const m of ["eth_getTransactionCount", "eth_estimateGas", "eth_feeHistory", "eth_sendRawTransaction", "eth_getLogs"]) {
    assert.ok(CONFIG.anonMethods.has(m), `${m} must be usable without a key`);
  }
  for (const m of ["ordo_sendBundle", "ordo_sendPrivateTransaction", "ordo_bundlerInfo"]) {
    assert.ok(!CONFIG.anonMethods.has(m), `${m} stays keyed`);
  }
  assert.ok(CONFIG.anonRateLimit > 0, "anonymous callers are rate limited per IP");
});
