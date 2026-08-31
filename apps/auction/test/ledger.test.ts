import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { RebateLedger } from "../src/ledger.ts";
import type { AuctionResult, Bid } from "../src/types.ts";

test("rebate split conserves value and credits the app", () => {
  const file = join(tmpdir(), `ordo-ledger-${Date.now()}.ndjson`);
  const ledger = new RebateLedger(file);

  const result: AuctionResult = {
    opportunityId: "o1",
    winner: "0xsearcher",
    clearingPriceWei: "1000000000000000000", // 1 ETH
    bidCount: 2,
    dispatchedAt: Date.now(),
  };
  const bid: Bid = { opportunityId: "o1", searcher: "0xsearcher", bidWei: "1000000000000000000", backrunRawTx: "0x", receivedAt: 0 };
  const app = "0xapp0000000000000000000000000000000000001";

  const entry = ledger.record(result, bid, app);
  const total = BigInt(entry.splits.userWei) + BigInt(entry.splits.appWei) + BigInt(entry.splits.protocolWei);
  assert.equal(total.toString(), "1000000000000000000", "splits sum to total");
  // defaults: user 90%, app 5%, protocol 5%
  assert.equal(entry.splits.userWei, "900000000000000000");
  assert.equal(entry.splits.appWei, "50000000000000000");
  assert.equal(ledger.balances()[app], "50000000000000000", "app credited");

  rmSync(file, { force: true });
});
