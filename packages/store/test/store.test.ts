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

test("api keys: issued once, found by hash, never stored in plaintext", () => {
  const store = new OrdoStore(":memory:");
  const { key, record } = store.issueApiKey({ label: "v4-fun", rebateAddress: "0xF177b7f781292FAa6d224C4a4fDefB1Eae80Ad2E" });

  assert.match(key, /^ordo_[0-9a-f]{36}$/);
  assert.equal(record.mode, "auction");
  assert.equal(store.apiKeyCount(), 1);

  const found = store.findApiKey(key);
  assert.equal(found?.label, "v4-fun");
  assert.equal(found?.rebateAddress, "0xf177b7f781292faa6d224c4a4fdefb1eae80ad2e");
  assert.equal(store.findApiKey("ordo_" + "0".repeat(36)), null);
});

test("api keys: no rebate address means direct mode; bad address refused", () => {
  const store = new OrdoStore(":memory:");
  const { record } = store.issueApiKey({ label: "reader" });
  assert.equal(record.mode, "direct");
  assert.throws(() => store.issueApiKey({ rebateAddress: "not-an-address" }), /not an address/);
});

test("leakage: scoped to pools, and priced profit is summed as bigint", () => {
  const s = new OrdoStore(":memory:");
  s.insertArbs([
    { ...arb("0xa", 10, "0xbot1", ["0xpoolA"]), profitIsQuote: true, profitToken: "0xWETH", profitWei: "1000000000000000000" },
    { ...arb("0xb", 11, "0xbot2", ["0xpoolA"]), profitIsQuote: true, profitToken: "0xweth", profitWei: "2000000000000000000" },
    // Long-tail profit: counted, not valued.
    { ...arb("0xc", 12, "0xbot1", ["0xpoolB"]), profitIsQuote: false, profitToken: "0xLONGTAIL", profitWei: "9999999999999999999999" },
  ]);

  const all = s.poolLeakage();
  assert.equal(all.arbs, 3);
  assert.equal(all.searchers, 2);
  assert.equal(all.pricedArbs, 2);
  assert.equal(all.profitByToken.length, 1, "one quote token");
  assert.equal(all.profitByToken[0].wei, 3_000_000_000_000_000_000n, "only quote-denominated profit counts");

  const scoped = s.poolLeakage(["0xpoolA"]);
  assert.equal(scoped.arbs, 2, "only arbs touching poolA");
  assert.equal(scoped.profitByToken[0].wei, 3_000_000_000_000_000_000n);
  assert.equal(scoped.firstBlock, 10);
  assert.equal(scoped.lastBlock, 11);
  s.close();
});

test("leakage: wei totals beyond double precision stay exact", () => {
  const s = new OrdoStore(":memory:");
  // Two profits whose sum is not representable exactly as a float64.
  s.insertArbs([
    { ...arb("0xa", 1, "0xbot", ["0xp"]), profitIsQuote: true, profitToken: "0xweth", profitWei: "9007199254740993000000000" },
    { ...arb("0xb", 2, "0xbot", ["0xp"]), profitIsQuote: true, profitToken: "0xweth", profitWei: "1" },
  ]);
  assert.equal(s.poolLeakage().profitByToken[0].wei, 9007199254740993000000001n);
  s.close();
});

test("arbsTouchingPool returns the transactions behind a singleton venue", () => {
  const s = new OrdoStore(":memory:");
  s.insertArbs([
    { ...arb("0xa", 10, "0xbot1", ["0xSingleton"]), profitIsQuote: true, profitToken: "0xweth", profitWei: "5" },
    { ...arb("0xb", 11, "0xbot2", ["0xsingleton", "0xother"]), profitIsQuote: false },
    { ...arb("0xc", 12, "0xbot1", ["0xother"]) },
  ]);

  // Case-folded on both sides: logs emit lowercase, explorers paste checksummed.
  const rows = s.arbsTouchingPool("0xSINGLETON");
  assert.equal(rows.length, 2, "only arbs that touched the singleton");
  assert.equal(rows[0].txHash, "0xb", "newest first");
  assert.equal(rows[1].profitWei, "5", "profit rides along for pricing");
  assert.equal(rows[1].profitIsQuote, true);
  s.close();
});

test("clearing measurements keeps what the chain cannot re-derive", () => {
  const s = new OrdoStore(":memory:");

  s.insertArbs([arb("0x1", 100, "0xalice", ["0xpoolA", "0xpoolB"])]);
  s.addSwaps(42);
  s.insertSettlement({
    opportunityId: "0xopp",
    searcher: "0xsearcher",
    chargeWei: "200000000000000",
    userAddress: "0xuser",
    appAddress: "0xapp",
    txHash: "0xsettletx",
    createdAt: 1,
  });
  const issued = s.issueApiKey({ label: "keep me" });
  assert.equal(s.totals().arbs, 1);

  s.clearMeasurements();

  assert.equal(s.totals().arbs, 0, "arbs are re-derivable from the chain, so they go");
  assert.equal(s.totals().pools, 0);
  assert.equal(s.swapCount(), 0);

  // These are the ones that cost real money to establish and cannot be
  // measured again: deleting the database file to rebuild the index took them
  // with it, and the site went back to reporting no settlements at all.
  assert.equal(s.settlementTotals().settlements, 1);
  assert.equal(s.settlementTotals().totalChargeWei, 200000000000000n);
  assert.ok(s.findApiKey(issued.key), "issued keys must survive an index rebuild");

  s.close();
});
