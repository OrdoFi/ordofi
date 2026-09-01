/**
 * Verifiable auction receipts.
 *
 * A sealed-bid second-price auction run by a single operator asks searchers to
 * trust that operator completely. Nothing in the mechanism itself stops the
 * auctioneer inventing a second bid to raise the clearing price the winner
 * pays, or quietly dropping a high bid so a favoured searcher wins. Jito's BAM
 * answers this with hardware enclaves. The same property is reachable with
 * signatures, and unlike an enclave attestation, anyone can check a signature.
 *
 * Two objects do the work:
 *
 *   - A **bid acknowledgement** is returned the instant a bid is accepted. It
 *     is the auctioneer's signature over that searcher's own bid. Holding one
 *     means the auctioneer cannot later deny receiving the bid or misstate its
 *     amount.
 *
 *   - A **receipt** is published when the auction closes, listing every bid
 *     received, the winner, and the clearing price, signed as a whole. A
 *     searcher checks their acknowledgement appears in it unchanged.
 *
 * A mismatch between the two is a signed, self-contained proof of misconduct:
 * both objects carry the auctioneer's signature, so nothing has to be taken on
 * anyone's word. Committing receipt hashes into a Merkle root on-chain extends
 * the same guarantee backwards in time, so history cannot be quietly rewritten
 * once published.
 */
import {
  keccak256,
  encodeAbiParameters,
  encodePacked,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

export const AUCTION_DOMAIN_NAME = "OrdoAuction";
export const AUCTION_DOMAIN_VERSION = "1";

export interface ReceiptBid {
  searcher: Address;
  bidWei: string;
  /** Milliseconds since epoch, as recorded by the auctioneer. */
  receivedAt: number;
  /**
   * The searcher's own EIP-712 signature over the OrdoSettlement `Bid` struct.
   *
   * This is what makes an invented bid impossible rather than merely
   * detectable. Without it the auctioneer could list a losing bid that never
   * existed, and since second price charges the winner the runner-up's
   * amount, fabricating one is the operator's most directly profitable
   * attack — the arithmetic would still check out. The auctioneer cannot forge
   * this signature, and it is the same one OrdoSettlement already demands
   * before debiting a bond, so it costs searchers nothing extra to produce.
   */
  bidSig?: Hex;
}

export interface BidAck {
  opportunityId: Hex;
  searcher: Address;
  bidWei: string;
  receivedAt: number;
  /** Auctioneer's EIP-712 signature over the above. */
  signature: Hex;
}

export interface AuctionReceipt {
  opportunityId: Hex;
  /** Every bid the auctioneer accepted, in the order received. */
  bids: ReceiptBid[];
  winner: Address | null;
  /** Second price: what the winner actually owes. */
  clearingPriceWei: string;
  closedAt: number;
  signature?: Hex;
}

export const ACK_TYPES = {
  BidAck: [
    { name: "opportunityId", type: "bytes32" },
    { name: "searcher", type: "address" },
    { name: "bidWei", type: "uint256" },
    { name: "receivedAt", type: "uint64" },
  ],
} as const;

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "opportunityId", type: "bytes32" },
    { name: "bidsHash", type: "bytes32" },
    { name: "winner", type: "address" },
    { name: "clearingPriceWei", type: "uint256" },
    { name: "closedAt", type: "uint64" },
  ],
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function auctionDomain(chainId: number, verifyingContract?: Address) {
  return {
    name: AUCTION_DOMAIN_NAME,
    version: AUCTION_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    ...(verifyingContract ? { verifyingContract } : {}),
  };
}

/** Auction ids are uuids; the signed form is a bytes32. */
export function opportunityIdToBytes32(id: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(id)) return id as Hex;
  return ("0x" + id.replace(/-/g, "").padEnd(64, "0")) as Hex;
}

/**
 * Commits to the bid list as an ordered vector. Order is part of the
 * commitment on purpose: "who bid first" is exactly the kind of detail an
 * operator could otherwise rewrite after the fact.
 */
export function hashBids(bids: readonly ReceiptBid[]): Hex {
  if (bids.length === 0) return keccak256("0x");
  const encoded = encodeAbiParameters(
    [
      { type: "address[]" },
      { type: "uint256[]" },
      { type: "uint64[]" },
    ],
    [
      bids.map((b) => b.searcher),
      bids.map((b) => BigInt(b.bidWei)),
      bids.map((b) => BigInt(b.receivedAt)),
    ],
  );
  return keccak256(encoded);
}

export function ackMessage(ack: Omit<BidAck, "signature">) {
  return {
    opportunityId: opportunityIdToBytes32(ack.opportunityId),
    searcher: ack.searcher,
    bidWei: BigInt(ack.bidWei),
    receivedAt: BigInt(ack.receivedAt),
  };
}

export function receiptMessage(receipt: Omit<AuctionReceipt, "signature">) {
  return {
    opportunityId: opportunityIdToBytes32(receipt.opportunityId),
    bidsHash: hashBids(receipt.bids),
    winner: receipt.winner ?? ZERO_ADDRESS,
    clearingPriceWei: BigInt(receipt.clearingPriceWei),
    closedAt: BigInt(receipt.closedAt),
  };
}

/**
 * viem's typed-data generics infer literal shapes that these runtime-built
 * arguments cannot satisfy. Narrowing once here keeps the casts out of the
 * call sites, where they were also silently widening `primaryType` to never.
 */
type TypedDataArgs = Parameters<typeof recoverTypedDataAddress>[0];

interface LooseTypedData {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
  signature: Hex;
}

function recoverTyped(args: LooseTypedData): Promise<Address> {
  return recoverTypedDataAddress(args as unknown as TypedDataArgs);
}

type Signer = (args: {
  domain: ReturnType<typeof auctionDomain>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<Hex>;

export async function signAck(
  ack: Omit<BidAck, "signature">,
  chainId: number,
  sign: Signer,
): Promise<BidAck> {
  const signature = await sign({
    domain: auctionDomain(chainId),
    types: ACK_TYPES as never,
    primaryType: "BidAck",
    message: ackMessage(ack) as never,
  });
  return { ...ack, signature };
}

export async function signReceipt(
  receipt: Omit<AuctionReceipt, "signature">,
  chainId: number,
  sign: Signer,
): Promise<AuctionReceipt> {
  const signature = await sign({
    domain: auctionDomain(chainId),
    types: RECEIPT_TYPES as never,
    primaryType: "Receipt",
    message: receiptMessage(receipt) as never,
  });
  return { ...receipt, signature };
}

export async function recoverAckSigner(ack: BidAck, chainId: number): Promise<Address> {
  return recoverTyped({
    domain: auctionDomain(chainId),
    types: ACK_TYPES,
    primaryType: "BidAck",
    message: ackMessage(ack),
    signature: ack.signature,
  });
}

export async function recoverReceiptSigner(
  receipt: AuctionReceipt,
  chainId: number,
): Promise<Address> {
  if (!receipt.signature) throw new Error("receipt is unsigned");
  return recoverTyped({
    domain: auctionDomain(chainId),
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: receiptMessage(receipt),
    signature: receipt.signature,
  });
}

export interface AuditFinding {
  ok: boolean;
  reason?: string;
}

/** The struct OrdoSettlement verifies before debiting a bond. */
export const SETTLEMENT_BID_TYPES = {
  Bid: [
    { name: "searcher", type: "address" },
    { name: "opportunityId", type: "bytes32" },
    { name: "maxAmountWei", type: "uint256" },
  ],
} as const;

export function settlementDomain(chainId: number, settlement: Address) {
  return {
    name: "OrdoSettlement",
    version: "1",
    chainId: BigInt(chainId),
    verifyingContract: settlement,
  };
}

/**
 * Every listed bid must carry its own searcher's signature. A bid without one,
 * or with one that recovers to somebody else, did not come from the searcher
 * it is attributed to.
 */
export async function auditBidAuthenticity(
  receipt: AuctionReceipt,
  chainId: number,
  settlement: Address,
): Promise<AuditFinding> {
  for (const bid of receipt.bids) {
    if (!bid.bidSig) {
      return { ok: false, reason: `bid from ${bid.searcher} carries no searcher signature` };
    }
    let signer: Address;
    try {
      signer = await recoverTyped({
        domain: settlementDomain(chainId, settlement),
        types: SETTLEMENT_BID_TYPES,
        primaryType: "Bid",
        message: {
          searcher: bid.searcher,
          opportunityId: opportunityIdToBytes32(receipt.opportunityId),
          maxAmountWei: BigInt(bid.bidWei),
        },
        signature: bid.bidSig,
      });
    } catch (e) {
      return { ok: false, reason: `bid from ${bid.searcher} has a malformed signature` };
    }
    if (signer.toLowerCase() !== bid.searcher.toLowerCase()) {
      return {
        ok: false,
        reason: `bid attributed to ${bid.searcher} was signed by ${signer}`,
      };
    }
  }
  return { ok: true };
}

/**
 * The check a searcher actually runs: does the receipt honour the
 * acknowledgement I was given, and is its arithmetic self-consistent?
 *
 * This deliberately does not need the searcher to trust anything the
 * auctioneer says now — both inputs are signed, so a failure here is evidence
 * rather than a complaint.
 */
export async function auditReceipt(
  receipt: AuctionReceipt,
  ack: BidAck,
  chainId: number,
  expectedAuctioneer: Address,
  settlement?: Address,
): Promise<AuditFinding> {
  const lower = (a: string) => a.toLowerCase();

  if (lower(receipt.opportunityId) !== lower(ack.opportunityId)) {
    return { ok: false, reason: "receipt is for a different opportunity" };
  }

  let receiptSigner: Address;
  let ackSigner: Address;
  try {
    receiptSigner = await recoverReceiptSigner(receipt, chainId);
    ackSigner = await recoverAckSigner(ack, chainId);
  } catch (e) {
    return { ok: false, reason: `signature malformed: ${(e as Error).message}` };
  }

  if (lower(receiptSigner) !== lower(expectedAuctioneer)) {
    return { ok: false, reason: `receipt signed by ${receiptSigner}, not the auctioneer` };
  }
  if (lower(ackSigner) !== lower(expectedAuctioneer)) {
    return { ok: false, reason: `acknowledgement signed by ${ackSigner}, not the auctioneer` };
  }

  const mine = receipt.bids.find((b) => lower(b.searcher) === lower(ack.searcher));
  if (!mine) {
    return { ok: false, reason: "the acknowledged bid is missing from the receipt" };
  }
  if (BigInt(mine.bidWei) !== BigInt(ack.bidWei)) {
    return {
      ok: false,
      reason: `bid altered: acknowledged ${ack.bidWei} wei, receipt says ${mine.bidWei} wei`,
    };
  }

  if (settlement) {
    const authentic = await auditBidAuthenticity(receipt, chainId, settlement);
    if (!authentic.ok) return authentic;
  }

  return auditClearingPrice(receipt);
}

/**
 * Second-price arithmetic, checkable by anyone from the receipt alone: the
 * winner must be the highest bidder, and must be charged the second-highest
 * bid — or their own, if theirs was the only one.
 */
export function auditClearingPrice(receipt: AuctionReceipt): AuditFinding {
  if (receipt.bids.length === 0) {
    if (receipt.winner && receipt.winner !== ZERO_ADDRESS) {
      return { ok: false, reason: "a winner was declared with no bids" };
    }
    return { ok: true };
  }

  const sorted = [...receipt.bids].sort((a, b) => (BigInt(b.bidWei) > BigInt(a.bidWei) ? 1 : -1));
  const highest = sorted[0];
  const expected = sorted.length >= 2 ? BigInt(sorted[1].bidWei) : BigInt(highest.bidWei);

  if (!receipt.winner || receipt.winner === ZERO_ADDRESS) {
    return { ok: false, reason: "bids were received but no winner was declared" };
  }
  if (receipt.winner.toLowerCase() !== highest.searcher.toLowerCase()) {
    return { ok: false, reason: `winner ${receipt.winner} did not submit the highest bid` };
  }
  if (BigInt(receipt.clearingPriceWei) !== expected) {
    return {
      ok: false,
      reason: `clearing price ${receipt.clearingPriceWei} wei should be ${expected} wei`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Merkle accumulation
//
// Signatures stop a receipt being forged. They do not stop one being withheld
// or replaced after the fact, because a searcher only ever sees their own.
// Publishing a root over a batch of receipts fixes the whole batch at a point
// in time, so a later substitution has to change the root to succeed — and the
// root is on-chain.
// ---------------------------------------------------------------------------

export function receiptHash(receipt: Omit<AuctionReceipt, "signature">): Hex {
  const m = receiptMessage(receipt);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
      ],
      [m.opportunityId, m.bidsHash, m.winner, m.clearingPriceWei, m.closedAt],
    ),
  );
}

const pairHash = (a: Hex, b: Hex): Hex =>
  BigInt(a) <= BigInt(b)
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));

export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return ("0x" + "00".repeat(32)) as Hex;
  let level = [...leaves];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      // An odd node is carried up rather than paired with itself, which would
      // make a single leaf indistinguishable from a two-identical-leaf tree.
      next.push(i + 1 < level.length ? pairHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const proof: Hex[] = [];
  let level = [...leaves];
  let idx = index;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx || i + 1 === idx) proof.push(level[i === idx ? i + 1 : i]);
        next.push(pairHash(level[i], level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let computed = leaf;
  for (const sibling of proof) computed = pairHash(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}
