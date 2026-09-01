import type { AuctionResult, Bid, Opportunity } from "./types.js";

export const AUCTION_WINDOW_MS = Number(process.env.ORDO_AUCTION_WINDOW_MS ?? 200);

/**
 * A single sealed-bid, second-price auction for the backrun right on one
 * opportunity. Mirrors the mechanism Arbitrum Timeboost uses for its express
 * lane: bids are hidden from each other, the highest bidder wins, and pays the
 * second-highest price (or their own bid if they're the only bidder).
 */
export class Auction {
  readonly opportunity: Opportunity;
  private bids: Bid[] = [];
  private closed = false;
  private resolver!: (r: { winner: Bid | null; clearingPriceWei: bigint }) => void;
  readonly settled: Promise<{ winner: Bid | null; clearingPriceWei: bigint }>;

  constructor(opportunity: Opportunity) {
    this.opportunity = opportunity;
    this.settled = new Promise((resolve) => (this.resolver = resolve));
    setTimeout(() => this.close(), AUCTION_WINDOW_MS);
  }

  submitBid(bid: Bid): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: "auction closed" };
    let wei: bigint;
    try {
      wei = BigInt(bid.bidWei);
    } catch {
      return { accepted: false, reason: "invalid bidWei" };
    }
    if (wei <= 0n) return { accepted: false, reason: "bid must be positive" };
    if (!bid.backrunRawTx?.startsWith("0x")) return { accepted: false, reason: "missing backrunRawTx" };
    this.bids.push(bid);
    return { accepted: true };
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.bids.length === 0) {
      this.resolver({ winner: null, clearingPriceWei: 0n });
      return;
    }
    const sorted = [...this.bids].sort((a, b) => (BigInt(b.bidWei) > BigInt(a.bidWei) ? 1 : -1));
    const winner = sorted[0];
    const clearing = sorted.length >= 2 ? BigInt(sorted[1].bidWei) : BigInt(sorted[0].bidWei);
    this.resolver({ winner, clearingPriceWei: clearing });
  }

  /** Every bid accepted, in arrival order — the receipt commits to both. */
  get allBids(): readonly Bid[] {
    return this.bids;
  }

  get bidCount(): number {
    return this.bids.length;
  }
}

export function toResult(
  opp: Opportunity,
  outcome: { winner: Bid | null; clearingPriceWei: bigint },
  bidCount: number,
  txHashes: { userTxHash?: string; backrunTxHash?: string },
): AuctionResult {
  return {
    opportunityId: opp.id,
    winner: outcome.winner?.searcher ?? null,
    clearingPriceWei: outcome.clearingPriceWei.toString(),
    bidCount,
    userTxHash: txHashes.userTxHash,
    backrunTxHash: txHashes.backrunTxHash,
    dispatchedAt: Date.now(),
  };
}
