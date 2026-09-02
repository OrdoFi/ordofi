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

test("candles: out-of-order points still yield correct open/close", () => {
  const s = new OrdoStore(":memory:");
  const pt = (block: number, price: number) => ({ pool: "0xPool", bucket: 600, price, vol0: 1, vol1: 2, block });

  // Concurrent block processing delivers newest first here.
  s.upsertCandles([pt(105, 9.0), pt(103, 7.0)]);
  s.upsertCandles([pt(101, 5.0), pt(104, 12.0)]);

  const [c] = s.candlesFor("0xPOOL", 0);
  assert.equal(c.open, 5.0, "open follows the earliest block, not the first arrival");
  assert.equal(c.close, 9.0, "close follows the latest block");
  assert.equal(c.high, 12.0);
  assert.equal(c.low, 5.0);
  assert.equal(c.swaps, 4);
  assert.equal(c.vol1, 8);

  assert.equal(s.candlesFor("0xpool", 601).length, 0, "window filter");
  s.upsertCandles([{ pool: "0xpool", bucket: 60, price: 1, vol0: 0, vol1: 0, block: 1 }]);
  assert.equal(s.pruneCandles(600), 1, "old buckets are dropped");
  assert.equal(s.candlesFor("0xpool", 0).length, 1);
  s.close();
});

test("marketStats: per-pool window summary spans buckets correctly", () => {
  const s = new OrdoStore(":memory:");
  const pt = (pool: string, bucket: number, block: number, price: number, vol1 = 1) =>
    ({ pool, bucket, price, vol0: 1, vol1, block });

  // Pool A trades across three minutes; the middle minute holds the high.
  s.upsertCandles([pt("0xa", 600, 10, 100), pt("0xa", 660, 20, 130, 5), pt("0xa", 720, 30, 110)]);
  // Pool B has one old bucket outside the window and one inside it.
  s.upsertCandles([pt("0xb", 60, 1, 1.0), pt("0xb", 720, 31, 2.0)]);

  const rows = s.marketStats(600);
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.pool === "0xa")!;
  assert.equal(a.open, 100, "open is the first bucket's open");
  assert.equal(a.close, 110, "close is the last bucket's close");
  assert.equal(a.high, 130);
  assert.equal(a.low, 100);
  assert.equal(a.swaps, 3);
  assert.equal(a.vol1, 7);
  assert.equal(a.firstBucket, 600);
  assert.equal(a.lastBucket, 720);
  assert.equal(rows[0].pool, "0xa", "busiest pool first");

  const b = rows.find((r) => r.pool === "0xb")!;
  assert.equal(b.open, 2.0, "buckets before the window do not leak into open");
  assert.equal(b.swaps, 1);
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

test("trades tape: newest first, idempotent inserts, pruned by time", () => {
  const s = new OrdoStore(":memory:");
  const t = (block: number, logIndex: number, ts: number) =>
    ({ pool: "0xPool", block, logIndex, txHash: `0xtx${block}${logIndex}`, amount0: "-1000", amount1: "2500000", sqrtPrice: "79228162514264337593543950336", ts });
  s.insertTrades([t(10, 0, 1000), t(10, 3, 1000), t(11, 1, 1001)]);
  s.insertTrades([t(11, 1, 1001)]); // duplicate delivery from a concurrent fetch
  const rows = s.recentTrades("0xPOOL", 10);
  assert.equal(rows.length, 3, "duplicates are ignored");
  assert.deepEqual(rows.map((r) => [r.block, r.logIndex]), [[11, 1], [10, 3], [10, 0]], "newest first, then log index");
  assert.equal(rows[0].amount0, "-1000", "int256 survives as exact text");
  assert.equal(s.recentTrades("0xpool", 2).length, 2, "limit honoured");
  assert.equal(s.pruneTrades(1001), 2, "older rows pruned by timestamp");
  assert.equal(s.recentTrades("0xpool").length, 1);
  s.close();
});

test("candlesAgg rolls minutes up into coarser buckets with correct open/close", () => {
  const s = new OrdoStore(":memory:");
  const pt = (bucket: number, block: number, price: number) => ({ pool: "0xp", bucket, price, vol0: 1, vol1: 10, block });
  // Three minutes in one 5-minute bucket, then one minute in the next.
  s.upsertCandles([pt(300, 1, 10), pt(360, 2, 14), pt(420, 3, 12), pt(600, 4, 20)]);
  const agg = s.candlesAgg("0xP", 0, 10_000, 300);
  assert.equal(agg.length, 2);
  assert.deepEqual([agg[0].bucket, agg[0].open, agg[0].high, agg[0].low, agg[0].close, agg[0].swaps, agg[0].vol1], [300, 10, 14, 10, 12, 3, 30]);
  assert.deepEqual([agg[1].bucket, agg[1].open, agg[1].close], [600, 20, 20]);
  assert.deepEqual(s.candleCoverage("0xp"), { from: 300, to: 600, minutes: 4 });
  assert.equal(s.candleCoverage("0xnone"), null);
  s.close();
});

test("a routing excursion cannot rescale the chart", () => {
  const store = new OrdoStore(":memory:");
  const POOL = "0xpool";
  // Three ordinary minutes, and one where a routed trade briefly drove the
  // pool 140x below the price either side of it.
  const pts: { pool: string; bucket: number; price: number; vol0: number; vol1: number; block: number }[] = [];
  for (let m = 0; m < 4; m++) {
    const b = 1_700_000_000 + m * 60;
    pts.push({ pool: POOL, bucket: b, price: 2400, vol0: 1, vol1: 1, block: m * 600 });
    pts.push({ pool: POOL, bucket: b, price: 2410, vol0: 1, vol1: 1, block: m * 600 + 599 });
    if (m === 2) pts.push({ pool: POOL, bucket: b, price: 17, vol0: 1, vol1: 1, block: m * 600 + 300 });
  }
  store.upsertCandles(pts);

  const minutes = store.candlesFor(POOL, 0);
  assert.equal(minutes.length, 4);
  const spiked = minutes[2];
  assert.equal(spiked.open, 2400);
  assert.equal(spiked.close, 2410);
  assert.equal(spiked.low, 1200); // 2400 / MAX_WICK, not 17
  assert.equal(spiked.swaps, 3); // the swap still counts, only the wick is bounded

  // And the excursion must not leak through the SQL roll-up either.
  const hourly = store.candlesAgg(POOL, 0, 1_700_009_999, 3600);
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].low, 1200);
  assert.equal(hourly[0].open, 2400);
  assert.equal(hourly[0].close, 2410);
  store.close();
});

test("routed flow: recorded at submit, counted only once confirmed and priced", () => {
  const s = new OrdoStore(":memory:");
  s.recordRouted({ txHash: "0xAA", sender: "0xS1", target: "0xR", valueWei: 10n, keyLabel: "anon", via: "protect" });
  s.recordRouted({ txHash: "0xaa", sender: "0xS1", keyLabel: "anon", via: "protect" }); // duplicate, ignored
  s.recordRouted({ txHash: "0xbb", keyLabel: "v4fun", via: "auction" });
  s.recordRouted({ txHash: "0xcc", keyLabel: "anon", via: "protect" });

  let t = s.routedTotals();
  assert.equal(t.submitted, 3);
  assert.equal(t.pending, 3);
  assert.equal(t.volumeUsd, 0, "nothing counts until it is confirmed");

  assert.deepEqual(s.unresolvedRouted().map((r) => r.txHash), ["0xaa", "0xbb", "0xcc"]);
  s.resolveRouted("0xAA", { status: 1, block: 100, volumeUsd: 1234.5 });
  s.resolveRouted("0xbb", { status: 0, block: 101, volumeUsd: 0 });
  s.resolveRouted("0xcc", { status: -1 });

  t = s.routedTotals();
  assert.equal(t.confirmed, 1);
  assert.equal(t.reverted, 1);
  assert.equal(t.pending, 0);
  assert.equal(t.volumeUsd, 1234.5);
  assert.equal(t.volume24hUsd, 1234.5);
  assert.equal(s.unresolvedRouted().length, 0);
  assert.equal(s.recentRouted(2)[0].txHash, "0xcc");
  s.close();
});
