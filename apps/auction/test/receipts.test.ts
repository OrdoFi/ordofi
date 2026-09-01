/**
 * The receipt log has to survive a restart. If it does not, the auction comes
 * back up believing it has issued nothing, and the next root it publishes
 * covers fewer receipts than the one already on-chain — which OrdoReceiptLog
 * rejects as a rewrite, leaving anchoring broken until the count catches up.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  merkleRoot,
  opportunityIdToBytes32,
  receiptHash,
  signReceipt,
  type AuctionReceipt,
} from "@ordofi/core/receipt";

const CHAIN_ID = 4663;
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);
const sign = (args: any) => account.signTypedData(args);

const UUIDS = [
  "11111111-2222-3333-4444-555555555555",
  "66666666-7777-8888-9999-aaaaaaaaaaaa",
];

async function receiptFor(uuid: string, bidWei: string): Promise<AuctionReceipt> {
  return signReceipt(
    {
      opportunityId: opportunityIdToBytes32(uuid),
      bids: [{ searcher: account.address, bidWei, receivedAt: 1 }],
      winner: account.address,
      clearingPriceWei: bidWei,
      closedAt: 2,
    },
    CHAIN_ID,
    sign,
  );
}

/**
 * receipts.ts hydrates at import time off env, so each case needs its own
 * module instance. A cache-busting query gets one without touching the loader.
 */
let instance = 0;
async function bootWith(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ordo-receipts-"));
  const log = join(dir, "receipts.ndjson");
  writeFileSync(log, lines.join(""));
  process.env.ORDO_RECEIPT_LOG = log;
  process.env.ORDO_AUCTIONEER_KEY = KEY;
  delete process.env.ORDO_RECEIPT_LOG_ADDRESS; // no anchoring, no network in tests
  const mod = await import(`../src/receipts.ts?case=${instance++}`);
  return { mod, log };
}

test("a restart restores the receipts it issued before", async () => {
  const [a, b] = await Promise.all([receiptFor(UUIDS[0], "10"), receiptFor(UUIDS[1], "20")]);
  const { mod } = await bootWith([a, b].map((r) => JSON.stringify(r) + "\n"));

  const root = mod.currentRoot();
  assert.equal(root.count, 2, "both receipts should be back in the log");
  assert.equal(root.root, merkleRoot([receiptHash(a), receiptHash(b)]));
  assert.equal(root.anchoredCount, 0);
});

test("a restored receipt is findable by the uuid the auction used", async () => {
  const a = await receiptFor(UUIDS[0], "10");
  const { mod } = await bootWith([JSON.stringify(a) + "\n"]);

  assert.equal(mod.getReceipt(UUIDS[0])?.signature, a.signature, "lookup by uuid");
  assert.equal(mod.getReceipt(a.opportunityId)?.signature, a.signature, "lookup by bytes32");
  assert.equal(mod.getReceipt("99999999-0000-0000-0000-000000000000"), null);
});

test("new receipts extend the restored log rather than restarting it", async () => {
  const a = await receiptFor(UUIDS[0], "10");
  const { mod, log } = await bootWith([JSON.stringify(a) + "\n"]);

  const published = await mod.publishReceipt(UUIDS[1], [], null, "0");
  assert.ok(published, "publishing needs the auctioneer key, which is set");

  assert.equal(mod.currentRoot().count, 2, "the root must cover both, not just the new one");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "appended, not truncated");
});

test("a torn final line does not stop the rest from loading", async () => {
  const [a, b] = await Promise.all([receiptFor(UUIDS[0], "10"), receiptFor(UUIDS[1], "20")]);
  const { mod } = await bootWith([
    JSON.stringify(a) + "\n",
    JSON.stringify(b) + "\n",
    '{"opportunityId":"0x1234', // killed mid-write
  ]);

  assert.equal(mod.currentRoot().count, 2);
});

test("no log at all is a fresh auction, not a failure", async () => {
  process.env.ORDO_RECEIPT_LOG = join(mkdtempSync(join(tmpdir(), "ordo-receipts-")), "absent.ndjson");
  process.env.ORDO_AUCTIONEER_KEY = KEY;
  const mod = await import(`../src/receipts.ts?case=${instance++}`);

  assert.equal(mod.currentRoot().count, 0);
  assert.equal(mod.receiptsEnabled(), true);
});
