import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther, type Hex } from "viem";
import {
  NATIVE_TOKEN,
  checkAnnouncement,
  computeStealthPrivateKey,
  decodeMetadata,
  encodeMetadata,
  encodeMetaAddress,
  fromPrivateKeys,
  generateStealthAddress,
  keysFromSignature,
  parseMetaAddress,
} from "../src/stealth.ts";

const SPEND = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const VIEW = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

test("a payment lands on an address only the recipient can spend", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const payment = generateStealthAddress(bob.metaAddress);

  // Bob recognises it from the announcement alone.
  const found = checkAnnouncement(bob, payment);
  assert.equal(found, payment.stealthAddress);

  // And the key he derives actually controls that address.
  const key = computeStealthPrivateKey(bob, payment.ephemeralPublicKey);
  assert.equal(privateKeyToAccount(key).address, payment.stealthAddress);
});

test("every payment to the same meta-address is a different, unlinkable address", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) seen.add(generateStealthAddress(bob.metaAddress).stealthAddress);
  assert.equal(seen.size, 25);
});

test("the viewing key finds payments but cannot spend them", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const payment = generateStealthAddress(bob.metaAddress);

  // A watcher holding only the viewing key still sees the payment...
  const watcher = { viewingPrivateKey: bob.viewingPrivateKey, spendingPublicKey: bob.spendingPublicKey };
  assert.equal(checkAnnouncement(watcher, payment), payment.stealthAddress);

  // ...but the spending key is what produces a usable key, and a wrong one
  // yields an address that controls nothing.
  const wrong = computeStealthPrivateKey(
    { spendingPrivateKey: VIEW, viewingPrivateKey: bob.viewingPrivateKey },
    payment.ephemeralPublicKey,
  );
  assert.notEqual(privateKeyToAccount(wrong).address, payment.stealthAddress);
});

test("someone else's announcement is not mistaken for ours", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const carol = fromPrivateKeys(
    "0x3333333333333333333333333333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444444444444444444444444444",
  );
  const toCarol = generateStealthAddress(carol.metaAddress);
  assert.equal(checkAnnouncement(bob, toCarol), null);
  // Not even with the tag stripped off, which is the case that matters: the
  // derived address simply is not the one that was announced.
  assert.equal(checkAnnouncement(bob, { ...toCarol, viewTag: undefined }), null);
});

test("the view tag discards almost everything without curve math", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const others = Array.from({ length: 512 }, (_, i) =>
    generateStealthAddress(
      fromPrivateKeys(
        `0x${(i + 10).toString(16).padStart(64, "0")}` as Hex,
        `0x${(i + 5000).toString(16).padStart(64, "0")}` as Hex,
      ).metaAddress,
    ),
  );
  // Not one of them is ours, tag or no tag.
  assert.equal(others.filter((a) => checkAnnouncement(bob, a) !== null).length, 0);
  assert.equal(
    others.filter((a) => checkAnnouncement(bob, { ...a, viewTag: undefined }) !== null).length,
    0,
  );

  // And our own payment is still found among them.
  const mine = generateStealthAddress(bob.metaAddress);
  assert.equal(checkAnnouncement(bob, mine), mine.stealthAddress);
});

test("keys are recovered from the same wallet signature every time", () => {
  const sig = ("0x" + "ab".repeat(65)) as Hex;
  const a = keysFromSignature(sig);
  const b = keysFromSignature(sig);
  assert.deepEqual(a, b);
  assert.match(a.metaAddress, /^st:rho:0x[0-9a-f]{132}$/);

  const other = keysFromSignature(("0x" + "cd".repeat(65)) as Hex);
  assert.notEqual(other.spendingPrivateKey, a.spendingPrivateKey);
  assert.notEqual(other.viewingPrivateKey, a.viewingPrivateKey);
  assert.notEqual(a.spendingPrivateKey, a.viewingPrivateKey);

  assert.throws(() => keysFromSignature("0xdeadbeef" as Hex), /65-byte signature/);
});

test("meta-addresses round-trip, and rubbish is refused", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const parsed = parseMetaAddress(bob.metaAddress);
  assert.equal(parsed.spendingPublicKey, bob.spendingPublicKey);
  assert.equal(parsed.viewingPublicKey, bob.viewingPublicKey);

  // Other tools publish the same keys under their own chain prefix.
  const asEth = bob.metaAddress.replace("st:rho:", "st:eth:");
  assert.deepEqual(parseMetaAddress(asEth), parsed);
  assert.deepEqual(parseMetaAddress(`  ${bob.metaAddress}  `), parsed);

  assert.throws(() => parseMetaAddress("st:rho:0x1234"), /not a stealth meta-address/);
  assert.throws(
    () => parseMetaAddress(encodeMetaAddress(("0x02" + "11".repeat(32)) as Hex, bob.viewingPublicKey)),
    /not on the curve/,
  );
});

test("metadata carries what was sent", () => {
  const eth = encodeMetadata({ viewTag: 0x2a, token: NATIVE_TOKEN, amount: parseEther("0.5") });
  assert.equal(eth.length, 2 + 2 + 40 + 64);
  assert.deepEqual(decodeMetadata(eth), { viewTag: 0x2a, token: NATIVE_TOKEN, amount: parseEther("0.5") });

  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex;
  assert.deepEqual(decodeMetadata(encodeMetadata({ viewTag: 0, token: usdg, amount: 1_000_000n })), {
    viewTag: 0,
    token: usdg,
    amount: 1_000_000n,
  });

  // A bare view tag, which the spec permits, must not throw.
  assert.deepEqual(decodeMetadata("0x2a"), { viewTag: 0x2a, token: NATIVE_TOKEN, amount: 0n });
  assert.equal(decodeMetadata("0x"), null);
});

test("a stealth address is spendable exactly once per announcement", () => {
  const bob = fromPrivateKeys(SPEND, VIEW);
  const first = generateStealthAddress(bob.metaAddress);
  const second = generateStealthAddress(bob.metaAddress);
  const k1 = computeStealthPrivateKey(bob, first.ephemeralPublicKey);
  const k2 = computeStealthPrivateKey(bob, second.ephemeralPublicKey);
  assert.notEqual(k1, k2);
  assert.equal(privateKeyToAccount(k1).address, first.stealthAddress);
  assert.equal(privateKeyToAccount(k2).address, second.stealthAddress);
});
