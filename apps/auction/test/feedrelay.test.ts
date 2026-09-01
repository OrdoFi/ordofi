import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeL2Msg } from "../src/feedrelay.ts";

const SIGNED_TX = 4;
const BATCH = 3;

function batchOf(...subs: Uint8Array[]): Uint8Array {
  const parts: number[] = [BATCH];
  for (const sub of subs) {
    // 8-byte big-endian length, matching the live feed's framing.
    parts.push(0, 0, 0, 0, (sub.length >> 24) & 0xff, (sub.length >> 16) & 0xff, (sub.length >> 8) & 0xff, sub.length & 0xff);
    parts.push(...sub);
  }
  return Uint8Array.from(parts);
}

const signedTx = (...payload: number[]) => Uint8Array.from([SIGNED_TX, ...payload]);

test("a single signed tx yields its payload", () => {
  const txs = decodeL2Msg(signedTx(0xde, 0xad, 0xbe, 0xef));
  assert.equal(txs.length, 1);
  assert.deepEqual([...txs[0]], [0xde, 0xad, 0xbe, 0xef]);
});

test("a batch yields every signed tx inside it", () => {
  const txs = decodeL2Msg(batchOf(signedTx(0x01), signedTx(0x02, 0x03)));
  assert.equal(txs.length, 2);
  assert.deepEqual([...txs[0]], [0x01]);
  assert.deepEqual([...txs[1]], [0x02, 0x03]);
});

test("non-tx kinds inside a batch are skipped, txs around them kept", () => {
  const heartbeat = Uint8Array.from([6]);
  const txs = decodeL2Msg(batchOf(signedTx(0xaa), heartbeat, signedTx(0xbb)));
  assert.equal(txs.length, 2);
});

test("unknown top-level kinds yield nothing", () => {
  assert.equal(decodeL2Msg(Uint8Array.from([0, 1, 2, 3])).length, 0);
  assert.equal(decodeL2Msg(Uint8Array.from([6])).length, 0);
});

test("a truncated batch does not read past the end or loop forever", () => {
  // Length prefix claims 100 bytes; only 2 follow.
  const lying = Uint8Array.from([BATCH, 0, 0, 0, 0, 0, 0, 0, 100, SIGNED_TX, 0x01]);
  assert.equal(decodeL2Msg(lying).length, 0);
});

test("a zero-length sub-message terminates parsing instead of spinning", () => {
  const zero = Uint8Array.from([BATCH, 0, 0, 0, 0, 0, 0, 0, 0, SIGNED_TX, 0x01]);
  assert.equal(decodeL2Msg(zero).length, 0);
});

test("a real batch captured from the live feed decodes to its transaction", () => {
  // First bytes of an actual wss://feed message observed on 2026-09-01:
  // kind 3, uint64 length 4, then a SignedTx sub-message.
  const real = Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0x02, 0xf8, 0xb0]);
  const txs = decodeL2Msg(real);
  assert.equal(txs.length, 1);
  assert.deepEqual([...txs[0]], [0x02, 0xf8, 0xb0]);
});

test("empty and single-byte inputs are rejected", () => {
  assert.equal(decodeL2Msg(Uint8Array.from([])).length, 0);
  assert.equal(decodeL2Msg(Uint8Array.from([SIGNED_TX])).length, 0);
});
