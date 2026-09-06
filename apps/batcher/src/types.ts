import type { Hex } from "viem";

/** An order as the contract hashes it. Ether out is `buyToken == 0x0`. */
export interface Order {
  owner: Hex;
  receiver: Hex;
  sellToken: Hex;
  buyToken: Hex;
  sellAmount: bigint;
  minBuyAmount: bigint;
  validTo: number;
  nonce: bigint;
  appData: Hex;
}

export type OrderStatus =
  | { state: "pending" }
  | { state: "awaiting_deposit" }
  | { state: "settling"; txHash: Hex }
  | { state: "filled"; txHash: Hex; buyAmount: bigint; alone: bigint | null; netted: boolean }
  | { state: "rejected"; reason: string }
  | { state: "expired" };

export interface Pending {
  order: Order;
  signature: Hex;
  hash: Hex;
  /** Funded by `depositOrder`; settled from escrow, no signature. */
  deposited: boolean;
  receivedAt: number;
  attempts: number;
  status: OrderStatus;
}

/** A hop on one venue, in the contract's shape. */
export interface Leg {
  venue: number;
  path: Hex;
  key: { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };
  zeroForOne: boolean;
}

export interface Interaction {
  legs: Leg[];
  amountIn: bigint;
}

export interface Price {
  token: Hex;
  price: bigint;
}

export interface SimResult {
  tokens: Hex[];
  delta: bigint[];
  owed: bigint[];
  buyAmounts: bigint[];
}

/** What one settlement did, for the ledger and /stats. */
export interface BatchRecord {
  at: number;
  txHash: Hex;
  tokenA: Hex;
  tokenB: Hex;
  orders: number;
  /** Volume that met a counterparty instead of the pool, in A units. */
  nettedA: bigint;
  residualA: bigint;
  residualB: bigint;
  feeToken: Hex;
  fee: bigint;
  gasUsed: bigint | null;
  ok: boolean;
}
