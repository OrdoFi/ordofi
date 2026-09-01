/**
 * Issues the signed acknowledgements and receipts that let searchers audit
 * this auction rather than trust it. See packages/core/src/receipt.ts for what
 * the two objects prove and why the searcher's own bid signature is the part
 * that matters.
 *
 * Signing needs the auctioneer key. Without it the auction still runs, but it
 * runs unverifiable, and says so at boot rather than quietly emitting receipts
 * nobody can check.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  merkleRoot,
  opportunityIdToBytes32,
  receiptHash,
  signAck,
  signReceipt,
  type AuctionReceipt,
  type BidAck,
  type ReceiptBid,
} from "@ordofi/core/receipt";
import type { Bid } from "./types.js";

const CHAIN_ID = 4663;
const AUCTIONEER_KEY = process.env.ORDO_AUCTIONEER_KEY as Hex | undefined;
const LOG = process.env.ORDO_RECEIPT_LOG ?? "data/receipts.ndjson";
const KEEP = Number(process.env.ORDO_RECEIPT_KEEP ?? 5000);

const account = AUCTIONEER_KEY ? privateKeyToAccount(AUCTIONEER_KEY) : null;
const sign = (args: any) => account!.signTypedData(args);

const byId = new Map<string, AuctionReceipt>();
const leaves: Hex[] = [];

export function receiptsEnabled(): boolean {
  return account !== null;
}

export function auctioneerAddress(): Address | null {
  return account?.address ?? null;
}

/** Signed proof that this bid was received, at this amount. */
export async function acknowledge(bid: Bid): Promise<BidAck | null> {
  if (!account) return null;
  return signAck(
    {
      opportunityId: opportunityIdToBytes32(bid.opportunityId),
      searcher: bid.searcher as Address,
      bidWei: bid.bidWei,
      receivedAt: bid.receivedAt,
    },
    CHAIN_ID,
    sign,
  );
}

export async function publishReceipt(
  opportunityId: string,
  bids: readonly Bid[],
  winner: string | null,
  clearingPriceWei: string,
): Promise<AuctionReceipt | null> {
  if (!account) return null;

  const receiptBids: ReceiptBid[] = bids.map((b) => ({
    searcher: b.searcher as Address,
    bidWei: b.bidWei,
    receivedAt: b.receivedAt,
    bidSig: b.bidSig as Hex | undefined,
  }));

  const receipt = await signReceipt(
    {
      opportunityId: opportunityIdToBytes32(opportunityId),
      bids: receiptBids,
      winner: (winner as Address) ?? null,
      clearingPriceWei,
      closedAt: Date.now(),
    },
    CHAIN_ID,
    sign,
  );

  byId.set(opportunityId, receipt);
  leaves.push(receiptHash(receipt));
  if (byId.size > KEEP) byId.delete(byId.keys().next().value as string);

  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify(receipt) + "\n");
  } catch {
    // A receipt that cannot be persisted is still worth serving live; losing
    // the log should not take the auction down.
  }

  return receipt;
}

export function getReceipt(id: string): AuctionReceipt | null {
  return byId.get(id) ?? null;
}

export function recentReceipts(n: number): AuctionReceipt[] {
  return [...byId.values()].slice(-n).reverse();
}

/**
 * Root over every receipt issued since boot. Committing this on-chain is what
 * stops a receipt being swapped out after publication; until then it is still
 * useful as a checksum searchers can compare against each other.
 */
export function currentRoot(): { root: Hex; count: number } {
  return { root: merkleRoot(leaves), count: leaves.length };
}
