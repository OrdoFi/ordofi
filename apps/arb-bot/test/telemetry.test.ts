import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, toEventSelector } from "viem";
import { Telemetry, edgeBps, parseLedger, replayTotals, wethReturned, type LedgerEvent } from "../src/telemetry.js";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";

test("edgeBps is signed and scaled to basis points", () => {
  assert.equal(edgeBps(parseEther("1"), parseEther("1.001")), 10);
  assert.equal(edgeBps(parseEther("1"), parseEther("0.9975")), -25);
  assert.equal(edgeBps(0n, 5n), 0);
});

test("wethReturned reads the router's Withdrawal and ignores everything else", () => {
  const topic = toEventSelector("Withdrawal(address,uint256)");
  const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const logs = [
    { address: WETH, topics: [topic, pad("0x1111111111111111111111111111111111111111")], data: "0x" + (5n).toString(16).padStart(64, "0") },
    { address: "0x2222222222222222222222222222222222222222", topics: [topic, pad(ROUTER)], data: "0x" + (7n).toString(16).padStart(64, "0") },
    { address: WETH.toUpperCase().replace("0X", "0x"), topics: [topic, pad(ROUTER)], data: "0x" + parseEther("0.1005").toString(16).padStart(64, "0") },
  ];
  assert.equal(wethReturned(logs, WETH, ROUTER), parseEther("0.1005"));
  assert.equal(wethReturned(logs.slice(0, 2), WETH, ROUTER), null);
  assert.equal(wethReturned(undefined, WETH, ROUTER), null);
});

test("ledger replay sums wins net of principal and all gas, and survives a torn line", () => {
  const lines: LedgerEvent[] = [
    { kind: "fire", t: 1, cycle: "A", sizeWei: "100", simNetWei: "3", hash: "0xa" },
    { kind: "won", t: 2, cycle: "A", sizeWei: "100", returnedWei: "104", estimated: false, gasWei: "1", hash: "0xa" },
    { kind: "fire", t: 3, cycle: "B", sizeWei: "100", simNetWei: "3", hash: "0xb" },
    { kind: "reverted", t: 4, cycle: "B", sizeWei: "100", gasWei: "2", hash: "0xb" },
  ];
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n{\"kind\":\"won\",\"t\":5,";
  const parsed = parseLedger(text);
  assert.equal(parsed.length, 4);
  const t = replayTotals(parsed);
  assert.deepEqual(t, { fires: 2, won: 1, reverted: 1, gasWei: 3n, grossWei: 4n });
});

test("Telemetry persists money events and rebuilds totals from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ordo-arb-"));
  const file = join(dir, "nested", "arb-ledger.ndjson");
  const ctx = {
    address: "0x1c345121479041218851565F6c41D2739a0b9913",
    chainId: 4663,
    startedAt: Date.now() - 5000,
    config: {},
    universe: () => ({ cycles: 1, routes: 1, crossTier: 1, triangular: 0, labels: ["X 500/3000"] }),
    chain: () => ({ balanceWei: parseEther("0.25"), budgetWei: parseEther("0.1"), maxFeePerGas: 2_000_000_000n }),
    gas24h: () => 0n,
    dailyGasCap: parseEther("0.01"),
    breaker: () => false,
  };

  const a = new Telemetry(file);
  assert.deepEqual(a.replay(), []);
  a.record({ kind: "fire", t: 1, cycle: "X 500/3000", sizeWei: parseEther("0.1").toString(), simNetWei: "1", hash: "0x1" });
  a.record({ kind: "won", t: 2, cycle: "X 500/3000", sizeWei: parseEther("0.1").toString(), returnedWei: parseEther("0.1002").toString(), estimated: false, gasWei: parseEther("0.00001").toString(), hash: "0x1" });
  a.note("pass", "too thin", "Y 100/500");
  a.scan({ t: 3, quotes: 320, bestBps: -4.2, bestLabel: "Y 100/500", positive: 0 });

  const s = a.snapshot(ctx);
  assert.equal(s.totals.fires, 1);
  assert.equal(s.totals.won, 1);
  assert.equal(s.totals.grossEth, "0.0002");
  assert.equal(s.totals.netEth, "0.00019");
  assert.equal(s.scans.count, 1);
  assert.equal(s.scans.last?.bestBps, -4.2);
  assert.equal(s.events.length, 3);
  assert.equal(s.balanceEth, "0.25");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);

  // A fresh process on the same volume sees the same money.
  const b = new Telemetry(file);
  const replayed = b.replay();
  assert.equal(replayed.length, 2);
  const s2 = b.snapshot(ctx);
  assert.equal(s2.totals.netEth, "0.00019");
  assert.equal(s2.scans.count, 0);
});
