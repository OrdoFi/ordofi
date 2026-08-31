import { test } from "node:test";
import assert from "node:assert/strict";
import { Auction } from "../src/auctioneer.ts";
import type { Opportunity } from "../src/types.ts";

function opp(): Opportunity {
  return {
    id: "opp-test",
    createdAt: Date.now(),
    hint: { poolsTouched: ["0xpool"], to: "0xto", selector: "0xdeadbeef", value: "0x0" },
    originLabel: "test",
  };
}

test("sealed-bid second-price: highest bidder wins, pays second price", async () => {
  const a = new Auction(opp());
  a.submitBid({ opportunityId: "opp-test", searcher: "0xlow", bidWei: "1000", backrunRawTx: "0x01", receivedAt: Date.now() });
  a.submitBid({ opportunityId: "opp-test", searcher: "0xhigh", bidWei: "5000", backrunRawTx: "0x02", receivedAt: Date.now() });
  a.submitBid({ opportunityId: "opp-test", searcher: "0xmid", bidWei: "3000", backrunRawTx: "0x03", receivedAt: Date.now() });

  const outcome = await a.settled;
  assert.equal(outcome.winner?.searcher, "0xhigh", "highest bidder wins");
  assert.equal(outcome.clearingPriceWei, 3000n, "pays the second-highest bid");
});

test("lone bidder pays their own bid", async () => {
  const a = new Auction(opp());
  a.submitBid({ opportunityId: "opp-test", searcher: "0xsolo", bidWei: "4200", backrunRawTx: "0x01", receivedAt: Date.now() });
  const outcome = await a.settled;
  assert.equal(outcome.winner?.searcher, "0xsolo");
  assert.equal(outcome.clearingPriceWei, 4200n);
});

test("no bids => no winner, zero clearing price", async () => {
  const a = new Auction(opp());
  const outcome = await a.settled;
  assert.equal(outcome.winner, null);
  assert.equal(outcome.clearingPriceWei, 0n);
});

test("rejects invalid bids", () => {
  const a = new Auction(opp());
  assert.equal(a.submitBid({ opportunityId: "opp-test", searcher: "0x", bidWei: "0", backrunRawTx: "0x01", receivedAt: 0 }).accepted, false);
  assert.equal(a.submitBid({ opportunityId: "opp-test", searcher: "0x", bidWei: "100", backrunRawTx: "", receivedAt: 0 }).accepted, false);
});
