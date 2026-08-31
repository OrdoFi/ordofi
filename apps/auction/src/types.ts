/**
 * An order-flow opportunity: a user transaction that OrdoFi is holding privately
 * and will submit. Searchers receive a redacted "hint" (MEV-Share style) — enough
 * to value a backrun (which pools it touches) without revealing the full calldata
 * that would let them front-run or copy it.
 */
export interface Opportunity {
  id: string;
  createdAt: number;
  /** Redacted hint broadcast to searchers. */
  hint: {
    poolsTouched: string[];
    to: string | null;
    /** Function selector only, not full calldata. */
    selector: string | null;
    /** Value transferred, if any (hex wei). */
    value: string;
  };
  /** The originating app/wallet, for rebate attribution (from the API key). */
  originLabel: string;
  originRebateAddress?: string;
}

export interface Bid {
  opportunityId: string;
  searcher: string;
  /** Bid amount in wei the searcher will pay for the backrun right. */
  bidWei: string;
  /** The signed backrun transaction to run immediately after the user tx. */
  backrunRawTx: string;
  receivedAt: number;
}

export interface AuctionResult {
  opportunityId: string;
  winner: string | null;
  /** Second-price: the winner pays the second-highest bid (or their own if lone bid). */
  clearingPriceWei: string;
  bidCount: number;
  userTxHash?: string;
  backrunTxHash?: string;
  dispatchedAt: number;
}

export interface LedgerEntry {
  opportunityId: string;
  at: number;
  totalWei: string;
  splits: {
    userWei: string;
    appWei: string;
    protocolWei: string;
  };
  appRebateAddress?: string;
  searcher: string;
}
