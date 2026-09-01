import type { HintLevel, SwapHint } from "@ordofi/core/simulate";

export type { HintLevel, SwapHint };

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
    /** Addresses of the pools the transaction was simulated to move. */
    poolsTouched: string[];
    /**
     * The same pools with their shape, direction, and — only at the `full`
     * hint level — their sizes. Direction is what prices a backrun; size is
     * what would let a searcher front-run instead, so it is withheld by default.
     */
    swaps: SwapHint[];
    to: string | null;
    /** Function selector only, not full calldata. */
    selector: string | null;
    /** Value transferred, if any (hex wei). */
    value: string;
    /**
     * False when the node could not give us logs — rate limited, or an
     * endpoint without `eth_simulateV1`. Searchers must read this rather than
     * treat an empty `swaps` as "this transaction moves no pools".
     */
    simulated: boolean;
    /** Which fields the hint was allowed to carry. */
    level: HintLevel;
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
  /**
   * EIP-712 signature over the OrdoSettlement Bid struct
   * (searcher, opportunityId, maxAmountWei = bidWei). Makes the bid
   * settlement-ready: the on-chain contract debits the clearing price from the
   * searcher's bond using this signature as proof of authorization. Optional
   * until on-chain settlement is enabled.
   */
  bidSig?: string;
  receivedAt: number;
}

/** A settlement-ready record produced when an auction has a winner. */
export interface SettlementRecord {
  opportunityId: string;
  searcher: string;
  /** Winner's signed max bid (wei). */
  maxAmountWei: string;
  /** Clearing (second) price actually owed (wei). */
  chargeWei: string;
  user: string;
  app: string;
  /** Searcher's EIP-712 signature authorizing up to maxAmountWei. */
  searcherSig?: string;
  createdAt: number;
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
