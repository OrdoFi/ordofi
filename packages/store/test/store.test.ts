import { test } from "node:test";
import assert from "node:assert/strict";
import { OrdoStore } from "../src/index.ts";

/**
 * The watcher checkpoints coarsely and is expected to be restarted, so it will
 * re-analyse blocks it has already written. Re-inserting the same arbitrage
 * must not inflate the counts the Explorer reports.
 */

function arb(txHash: string, block: number, sender: string, pools: string[]) {
  return { txHash, block, timestamp: 1_700_000_000 + block, sender, pools, profitIsQuote: false };
}

test("totals and leaderboards are computed from the index", () => {
  const s = new OrdoStore(":memory:");
  s.insertArbs([
    arb("0x1", 100, "0xalice", ["0xpoolA", "0xpoolB"]),
    arb("0x2", 101, "0xalice", ["0xpoolA"]),
    arb("0x3", 102, "0xbob", ["0xpoolB"]),
  ]);

  const t = s.totals();
  assert.equal(t.arbs, 3);
  assert.equal(t.searchers, 2, "two distinct senders");
  assert.equal(t.pools, 2, "two distinct pools");

  assert.deepEqual(s.topSearchers(1), [{ address: "0xalice", count: 2 }]);
  assert.equal(s.topPools(1)[0].pool, "0xpoolA");
  s.close();
});

test("replaying a block does not double-count", () => {
  const s = new OrdoStore(":memory:");
  const batch = [arb("0x1", 100, "0xalice", ["0xpoolA"]), arb("0x2", 100, "0xbob", ["0xpoolA"])];
  s.insertArbs(batch);
  s.insertArbs(batch); // watcher restarted and re-analysed the same block

  assert.equal(s.totals().arbs, 2, "same transactions, still two rows");
  assert.equal(s.topPools(1)[0].count, 2, "pool count is not inflated either");
  s.close();
});

test("recentArbs is newest-first and bounded", () => {
  const s = new OrdoStore(":memory:");
  s.insertArbs([1, 2, 3, 4, 5].map((i) => arb("0x" + i, 100 + i, "0xalice", ["0xpoolA"])));
  const recent = s.recentArbs(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].block, 105, "newest first");
  assert.deepEqual(recent[0].pools, ["0xpoolA"], "pools round-trip as an array");
  s.close();
});

test("window reports the indexed block range and span", () => {
  const s = new OrdoStore(":memory:");
  s.insertArbs([arb("0x1", 100, "0xa", ["0xp"]), arb("0x2", 3700, "0xb", ["0xp"])]);
  const w = s.window();
  assert.equal(w.minBlock, 100);
  assert.equal(w.maxBlock, 3700);
  assert.ok(w.spanHours > 0.99 && w.spanHours < 1.01, "3600s of timestamps is one hour");
  s.close();
});

test("swaps are counted, not stored", () => {
  const s = new OrdoStore(":memory:");
  s.addSwaps(120);
  s.addSwaps(80);
  s.addSwaps(0);
  assert.equal(s.swapCount(), 200, "counter accumulates across blocks");
  s.close();
});

test("settlements are recorded and attributed to an app", () => {
  const s = new OrdoStore(":memory:");
  s.insertSettlement({
    opportunityId: "o1",
    searcher: "0xsearcher",
    chargeWei: "1000",
    userAddress: "0xuser",
    appAddress: "0xapp",
    createdAt: 1,
  });
  s.insertSettlement({
    opportunityId: "o2",
    searcher: "0xsearcher",
    chargeWei: "2000",
    userAddress: "0xuser",
    appAddress: "0xapp",
    createdAt: 2,
  });

  assert.equal(s.totals().settlements, 2);
  assert.equal(s.recentSettlements(1)[0].opportunityId, "o2", "newest first");
  assert.deepEqual(s.appEarnings("0xapp"), { settlements: 2, totalChargedWei: "3000" });
  s.close();
});
