/**
 * These tests are written as attacks. Each one is something a dishonest
 * auctioneer would gain from, and the assertion is that the receipt catches it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther, type Address, type Hex } from "viem";

import {
  auditReceipt,
  auditClearingPrice,
  auditBidAuthenticity,
  signAck,
  signReceipt,
  recoverAckSigner,
  recoverReceiptSigner,
  settlementDomain,
  SETTLEMENT_BID_TYPES,
  opportunityIdToBytes32,
  receiptHash,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  type AuctionReceipt,
  type ReceiptBid,
} from "../src/receipt.ts";

const CHAIN = 4663;
const SETTLEMENT = "0xbC680922DaF2F65a8B957e5238857f8c68BeDabb" as Address;

const auctioneer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const alice = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const bob = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);

const OPP = "3f2b1c4a-0000-4000-8000-000000000001";
const sign = (args: any) => auctioneer.signTypedData(args);

async function searcherBid(
  account: typeof alice,
  bidWei: bigint,
  receivedAt: number,
): Promise<ReceiptBid> {
  const bidSig = await account.signTypedData({
    domain: settlementDomain(CHAIN, SETTLEMENT),
    types: SETTLEMENT_BID_TYPES as never,
    primaryType: "Bid",
    message: {
      searcher: account.address,
      opportunityId: opportunityIdToBytes32(OPP),
      maxAmountWei: bidWei,
    } as never,
  });
  return { searcher: account.address, bidWei: bidWei.toString(), receivedAt, bidSig };
}

/**
 * The attacker here is the operator, and the operator holds the signing key.
 * Tampering and then re-signing is what a real dishonest auctioneer would do,
 * so every tamper test seals its forgery properly. Anything less would only be
 * testing that a broken signature is a broken signature.
 */
async function reseal(receipt: AuctionReceipt): Promise<AuctionReceipt> {
  return signReceipt({ ...receipt, signature: undefined }, CHAIN, sign);
}

async function honestAuction() {
  const bids = [
    await searcherBid(alice, parseEther("0.05"), 1_000),
    await searcherBid(bob, parseEther("0.03"), 1_050),
  ];
  const receipt = await signReceipt(
    {
      opportunityId: opportunityIdToBytes32(OPP),
      bids,
      winner: alice.address,
      clearingPriceWei: parseEther("0.03").toString(), // second price
      closedAt: 1_200,
    },
    CHAIN,
    sign,
  );
  const ack = await signAck(
    {
      opportunityId: opportunityIdToBytes32(OPP),
      searcher: alice.address,
      bidWei: parseEther("0.05").toString(),
      receivedAt: 1_000,
    },
    CHAIN,
    sign,
  );
  return { receipt, ack, bids };
}

test("an honest auction passes the audit", async () => {
  const { receipt, ack } = await honestAuction();
  const finding = await auditReceipt(receipt, ack, CHAIN, auctioneer.address, SETTLEMENT);
  assert.equal(finding.reason, undefined);
  assert.equal(finding.ok, true);
});

test("signatures recover to the auctioneer", async () => {
  const { receipt, ack } = await honestAuction();
  assert.equal(await recoverAckSigner(ack, CHAIN), auctioneer.address);
  assert.equal(await recoverReceiptSigner(receipt, CHAIN), auctioneer.address);
});

test("dropping a bid from the receipt is caught", async () => {
  const { receipt, ack } = await honestAuction();
  const tampered: AuctionReceipt = {
    ...receipt,
    bids: receipt.bids.filter((b) => b.searcher !== alice.address),
    winner: bob.address,
    clearingPriceWei: parseEther("0.03").toString(),
  };
  const finding = await auditReceipt(await reseal(tampered), ack, CHAIN, auctioneer.address, SETTLEMENT);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /missing from the receipt/);
});

test("altering an acknowledged bid amount is caught", async () => {
  const { receipt, ack } = await honestAuction();
  const tampered: AuctionReceipt = {
    ...receipt,
    bids: receipt.bids.map((b) =>
      b.searcher === alice.address ? { ...b, bidWei: parseEther("0.09").toString() } : b,
    ),
  };
  const finding = await auditReceipt(await reseal(tampered), ack, CHAIN, auctioneer.address, SETTLEMENT);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /bid altered/);
});

test("a fabricated runner-up cannot be signed, so it is caught", async () => {
  // The operator's most profitable lie: invent a second bid just under the
  // winner's to raise the second price. The arithmetic is consistent; only the
  // missing searcher signature gives it away.
  const { receipt, ack } = await honestAuction();
  const ghost = "0x000000000000000000000000000000000000dEaD" as Address;
  const tampered: AuctionReceipt = {
    ...receipt,
    bids: [
      receipt.bids[0],
      { searcher: ghost, bidWei: parseEther("0.049").toString(), receivedAt: 1_100 },
    ],
    clearingPriceWei: parseEther("0.049").toString(),
  };

  const sealed = await reseal(tampered);

  // Arithmetic alone is fooled, and so is the receipt signature...
  assert.equal(auditClearingPrice(sealed).ok, true);
  assert.equal(await recoverReceiptSigner(sealed, CHAIN), auctioneer.address);

  // ...but the ghost bidder's own signature cannot be produced.
  const finding = await auditReceipt(sealed, ack, CHAIN, auctioneer.address, SETTLEMENT);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /no searcher signature/);
});

test("a bid signed by the wrong key is caught", async () => {
  const stolen = await searcherBid(bob, parseEther("0.04"), 1_100);
  const receipt: AuctionReceipt = {
    opportunityId: opportunityIdToBytes32(OPP),
    bids: [{ ...stolen, searcher: alice.address }],
    winner: alice.address,
    clearingPriceWei: parseEther("0.04").toString(),
    closedAt: 1_200,
  };
  const finding = await auditBidAuthenticity(receipt, CHAIN, SETTLEMENT);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /was signed by/);
});

test("overcharging the winner is caught by the arithmetic", async () => {
  const { receipt } = await honestAuction();
  const overcharged: AuctionReceipt = {
    ...receipt,
    clearingPriceWei: parseEther("0.05").toString(), // charged their own bid, not second price
  };
  const finding = auditClearingPrice(overcharged);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /clearing price/);
});

test("declaring the wrong winner is caught", async () => {
  const { receipt } = await honestAuction();
  const finding = auditClearingPrice({ ...receipt, winner: bob.address });
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /did not submit the highest bid/);
});

test("a lone bidder pays their own bid", async () => {
  const bids = [await searcherBid(alice, parseEther("0.05"), 1_000)];
  const finding = auditClearingPrice({
    opportunityId: opportunityIdToBytes32(OPP),
    bids,
    winner: alice.address,
    clearingPriceWei: parseEther("0.05").toString(),
    closedAt: 1_200,
  });
  assert.equal(finding.ok, true);
});

test("a receipt from another auction is rejected", async () => {
  const { receipt, ack } = await honestAuction();
  const other = { ...receipt, opportunityId: opportunityIdToBytes32("ffffffff-0000-4000-8000-000000000002") };
  const finding = await auditReceipt(other as AuctionReceipt, ack, CHAIN, auctioneer.address);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /different opportunity/);
});

test("a receipt signed by someone other than the auctioneer is rejected", async () => {
  const { receipt, ack } = await honestAuction();
  const impostor = await signReceipt(
    { ...receipt, signature: undefined },
    CHAIN,
    (args: any) => bob.signTypedData(args),
  );
  const finding = await auditReceipt(impostor, ack, CHAIN, auctioneer.address);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /not the auctioneer/);
});

test("merkle proofs verify for every leaf, including an odd tree", async () => {
  const leaves: Hex[] = [];
  for (let i = 0; i < 5; i++) {
    leaves.push(
      receiptHash({
        opportunityId: opportunityIdToBytes32(`aaaaaaaa-0000-4000-8000-00000000000${i}`),
        bids: [],
        winner: null,
        clearingPriceWei: "0",
        closedAt: 1_000 + i,
      }),
    );
  }
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    assert.equal(verifyMerkleProof(leaves[i], merkleProof(leaves, i), root), true, `leaf ${i}`);
  }
  // A leaf that was never committed must not verify.
  const forged = receiptHash({
    opportunityId: opportunityIdToBytes32("bbbbbbbb-0000-4000-8000-000000000000"),
    bids: [],
    winner: null,
    clearingPriceWei: "0",
    closedAt: 9_999,
  });
  assert.equal(verifyMerkleProof(forged, merkleProof(leaves, 0), root), false);
});

test("changing any receipt changes the root", async () => {
  const base = {
    opportunityId: opportunityIdToBytes32(OPP),
    bids: await Promise.all([searcherBid(alice, parseEther("0.05"), 1_000)]),
    winner: alice.address,
    clearingPriceWei: parseEther("0.05").toString(),
    closedAt: 1_200,
  };
  const before = merkleRoot([receiptHash(base)]);
  const after = merkleRoot([receiptHash({ ...base, clearingPriceWei: parseEther("0.06").toString() })]);
  assert.notEqual(before, after);
});

test("tampering without the signing key breaks the receipt signature", async () => {
  const { receipt, ack } = await honestAuction();
  const outsider: AuctionReceipt = {
    ...receipt,
    clearingPriceWei: parseEther("0.049").toString(),
  };
  const finding = await auditReceipt(outsider, ack, CHAIN, auctioneer.address, SETTLEMENT);
  assert.equal(finding.ok, false);
  assert.match(finding.reason!, /not the auctioneer/);
});
