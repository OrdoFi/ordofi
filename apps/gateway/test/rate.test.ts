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
