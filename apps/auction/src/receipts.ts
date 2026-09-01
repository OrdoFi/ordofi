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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { ENDPOINTS, normalizePrivateKey, robinhoodChain } from "@ordofi/core";
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
const AUCTIONEER_KEY = normalizePrivateKey(process.env.ORDO_AUCTIONEER_KEY, "ORDO_AUCTIONEER_KEY");
const LOG = process.env.ORDO_RECEIPT_LOG ?? "data/receipts.ndjson";
const KEEP = Number(process.env.ORDO_RECEIPT_KEEP ?? 5000);

const account = AUCTIONEER_KEY ? privateKeyToAccount(AUCTIONEER_KEY) : null;
const sign = (args: any) => account!.signTypedData(args);

/** Keyed by the signed bytes32 form, so a uuid and its bytes32 find the same receipt. */
const byId = new Map<string, AuctionReceipt>();
const leaves: Hex[] = [];

function remember(receipt: AuctionReceipt): void {
  byId.set(receipt.opportunityId.toLowerCase(), receipt);
  leaves.push(receiptHash(receipt));
  if (byId.size > KEEP) byId.delete(byId.keys().next().value as string);
}

/**
 * Receipts have to outlive the process, and not only so /receipts survives a
 * deploy. The Merkle log is append-only on-chain: a restart that began again
 * from an empty set would publish a root covering fewer receipts than the last
 * one, which OrdoReceiptLog reads as the log being rewritten and rejects — so
 * anchoring would stay broken until the count climbed back past where it was.
 */
function hydrate(): void {
  let raw: string;
  try {
    raw = readFileSync(LOG, "utf8");
  } catch {
    return; // no log yet, or unreadable — a fresh auction, not a corrupt one
  }
  let torn = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      remember(JSON.parse(line) as AuctionReceipt);
    } catch {
      torn++; // a half-written final line from an unclean shutdown
    }
  }
  if (leaves.length > 0) {
    console.log(
      `[receipts] restored ${leaves.length} receipts from ${LOG}` +
        (torn > 0 ? ` (${torn} unreadable line${torn === 1 ? "" : "s"} skipped)` : ""),
    );
  }
}

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

  remember(receipt);

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
  {
    type: "function",
    name: "latest",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "root", type: "bytes32" },
          { name: "count", type: "uint64" },
          { name: "committedAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "total",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

let lastCommittedCount = 0;
let committing = false;

/** What the chain already has, so a restart never re-commits ground it covered. */
async function syncAnchorState(): Promise<void> {
  if (!LOG_ADDRESS) return;
  try {
    const client = createPublicClient({
      chain: robinhoodChain,
      transport: http(process.env.ORDO_RPC_URL ?? ENDPOINTS.rpc),
    });
    const read = { address: LOG_ADDRESS, abi: COMMIT_ABI } as const;
    if ((await client.readContract({ ...read, functionName: "total" })) === 0n) return;
    const latest = await client.readContract({ ...read, functionName: "latest" });
    lastCommittedCount = Number(latest.count);
    console.log(`[anchor] chain already covers ${lastCommittedCount} receipts`);
  } catch (e) {
    // Leaving this at 0 only costs a redundant commit, so a flaky RPC at boot
    // must not stop the auction from starting.
    console.error(`[anchor] could not read committed state: ${(e as Error).message}`);
  }
}

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
  if (leaves.length < lastCommittedCount) {
    // The local log lost receipts the chain has already anchored — rotated,
    // truncated, or restored from a stale volume. Committing now would be the
    // rewrite the contract exists to reject, so say so and stay quiet.
    console.error(
      `[anchor] refusing to commit: ${leaves.length} receipts locally, ${lastCommittedCount} anchored on-chain`,
    );
    return;
  }

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
  return byId.get(opportunityIdToBytes32(id).toLowerCase()) ?? null;
}

export function recentReceipts(n: number): AuctionReceipt[] {
  return [...byId.values()].slice(-n).reverse();
}

/**
 * Root over every receipt this auction has ever issued, restarts included.
 * Committing it on-chain is what stops a receipt being swapped out after
 * publication; until then it is still useful as a checksum searchers can
 * compare against each other. `anchoredCount` is the prefix already on-chain,
 * so the gap between it and `count` is exactly what is not yet immutable.
 */
export function currentRoot(): { root: Hex; count: number; anchoredCount: number } {
  return { root: merkleRoot(leaves), count: leaves.length, anchoredCount: lastCommittedCount };
}

hydrate();
void syncAnchorState();
