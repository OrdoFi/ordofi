import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HeadlineStats, type Prices, type Store } from "../src/headline.ts";

const SPLIT = { user: 0.9, app: 0.05, protocol: 0.05 };
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ODD = "0x00000000000000000000000000000000000000aa";

const store = (over: Partial<Store> = {}): Store => ({
  routedTotals: () => ({ confirmed: 1210, confirmed24h: 565, volumeUsd: 979_677.04, volume24hUsd: 807_209.54, firstAt: 1_700_000_000 }),
  activeSearchers: () => 2123,
  pricedProfit: () => ({ arbs: 41, pricedArbs: 40, profitByToken: [{ token: WETH, wei: 10n ** 18n, arbs: 40 }] }),
  ...over,
});

const prices: Prices = {
  usd: (t) => (t.toLowerCase() === WETH ? 2450 : null),
  decimals: (t) => (t.toLowerCase() === WETH ? 18 : null),
};

describe("the front page's numbers", () => {
  it("reads them from the index this process already has open", () => {
    const h = new HeadlineStats(store(), prices, SPLIT);
    assert.equal(h.get(), null, "nothing until the first pass");
    h.refresh();
    const v = h.get()!;
    assert.equal(v.protectedVolumeUsd, 979_677.04);
    assert.equal(v.transactions24h, 565);
    assert.equal(v.activeSearchers24h, 2123);
    assert.equal(v.mevObservedArbs24h, 41);
    assert.equal(v.mevObservedUsd24h, 2450, "one ether of profit at $2,450");
    assert.deepEqual(v.rebateSplit, SPLIT);
  });

  it("says null rather than zero when the profit cannot be priced", () => {
    // A made-up number on a public page is worse than a blank, and "$0.00"
    // beside a real arbitrage count reads as a claim that it was worthless.
    const h = new HeadlineStats(
      store({ pricedProfit: () => ({ arbs: 9, pricedArbs: 0, profitByToken: [{ token: ODD, wei: 5n, arbs: 9 }] }) }),
      prices,
      SPLIT,
    );
    h.refresh();
    assert.equal(h.get()!.mevObservedUsd24h, null);
    assert.equal(h.get()!.mevObservedArbs24h, 9, "the count needs no price and is still true");
  });

  it("reports a floor when only some tokens can be priced", () => {
    const h = new HeadlineStats(
      store({
        pricedProfit: () => ({
          arbs: 2,
          pricedArbs: 1,
          profitByToken: [
            { token: WETH, wei: 10n ** 18n, arbs: 1 },
            { token: ODD, wei: 10n ** 30n, arbs: 1 },
          ],
        }),
      }),
      prices,
      SPLIT,
    );
    h.refresh();
    assert.equal(h.get()!.mevObservedUsd24h, 2450, "the unpriced token is left out, not guessed at");
  });

  it("keeps the last good reading when the index throws", () => {
    let broken = false;
    const h = new HeadlineStats(
      store({
        routedTotals: () => {
          if (broken) throw new Error("database is locked");
          return { confirmed: 5, confirmed24h: 5, volumeUsd: 100, volume24hUsd: 100, firstAt: 1 };
        },
      }),
      prices,
      SPLIT,
    );
    h.refresh();
    assert.equal(h.get()!.transactions, 5);
    broken = true;
    h.refresh();
    assert.equal(h.get()!.transactions, 5, "a reading we could not take leaves the last one standing");
  });

  it("serves something parseable before the first pass", () => {
    const h = new HeadlineStats(store(), prices, SPLIT);
    const j = JSON.parse(h.json());
    assert.equal(j.unavailable, true, "so the page can tell 'not yet' from 'zero'");
  });

  it("works with no index at all, which is a bare dev box", () => {
    const h = new HeadlineStats(null, null, SPLIT);
    h.refresh();
    assert.equal(h.get(), null);
    assert.equal(JSON.parse(h.json()).unavailable, true);
  });
});
