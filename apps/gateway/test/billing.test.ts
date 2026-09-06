import { test } from "node:test";
import assert from "node:assert/strict";
import { OrdoStore } from "@ordofi/store";
import { canSend, chargeSend, priceMicros } from "../src/billing.ts";

test("price is $0.01 in micros", () => {
  assert.equal(priceMicros(0.01), 10_000);
  assert.equal(priceMicros(0), 0);
});

test("enforce only blocks a keyed send with no prepaid", () => {
  const s = new OrdoStore(":memory:");
  assert.equal(canSend(s, "v4fun", 0.01, true), false);
  assert.equal(canSend(s, "anon", 0.01, true), true);
  assert.equal(canSend(s, "v4fun", 0.01, false), true);
  chargeSend(null, "v4fun", 0.01);
  chargeSend(s, "anon", 0.01);
  assert.equal(s.keyBilling("anon").sends, 0);
  chargeSend(s, "v4fun", 0.01);
  assert.equal(s.keyBilling("v4fun").owedUsdMicros, 10_000);
  s.close();
});
