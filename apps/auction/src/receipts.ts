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
import { createWalletClient, http, type Address, type Hex } from "viem";
import { ENDPOINTS, robinhoodChain } from "@ordofi/core";
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

  void maybeCommitRoot();

  return receipt;
}

// ---------------------------------------------------------------------------
// On-chain anchoring
//
// Signatures make receipts unforgeable; the OrdoReceiptLog contract makes the
// set of them unrewritable. Commits are batched — anchoring is a durability
// property, not a latency one, and a root every N auctions bounds what a
// malicious operator could ever retract to the last N receipts.
// ---------------------------------------------------------------------------

const LOG_ADDRESS = process.env.ORDO_RECEIPT_LOG_ADDRESS as Address | undefined;
const COMMIT_EVERY = Number(process.env.ORDO_RECEIPT_COMMIT_EVERY ?? 25);

const COMMIT_ABI = [
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "count", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

let lastCommittedCount = 0;
let committing = false;

export function anchoringEnabled(): boolean {
  return Boolean(account && LOG_ADDRESS);
}

/** Distinguishes "no contract configured" from "no key to sign with". */
export function anchoringConfigured(): boolean {
  return Boolean(LOG_ADDRESS);
}

async function maybeCommitRoot(): Promise<void> {
  if (!account || !LOG_ADDRESS || committing) return;
  if (leaves.length - lastCommittedCount < COMMIT_EVERY) return;

  committing = true;
  const count = leaves.length;
  const root = merkleRoot(leaves.slice(0, count));
  try {
    const wallet = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: http(process.env.ORDO_RPC_URL ?? ENDPOINTS.rpc),
    });
    const hash = await wallet.writeContract({
      address: LOG_ADDRESS,
      abi: COMMIT_ABI,
      functionName: "commit",
      args: [root, BigInt(count)],
    });
    lastCommittedCount = count;
    console.log(`[anchor] committed root over ${count} receipts — ${hash}`);
  } catch (e) {
    // Next receipt retries. Anchoring lag is visible on /receipts/root, so a
    // persistently failing commit shows up rather than rotting silently.
    console.error(`[anchor] commit failed: ${(e as Error).message}`);
  } finally {
    committing = false;
  }
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
export function currentRoot(): { root: Hex; count: number; anchoredCount: number } {
  return { root: merkleRoot(leaves), count: leaves.length, anchoredCount: lastCommittedCount };
}
