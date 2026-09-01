import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENDPOINTS, normalizePrivateKey, robinhoodChain } from "@ordofi/core";
import type { SettlementRecord } from "./types.js";

/**
 * On-chain settlement submitter — closes the revenue loop.
 *
 * After an auction resolves, this debits the winner's bond via OrdoSettlement
 * and credits the user/app/protocol split. The contract verifies the searcher's
 * own EIP-712 signature, so the auctioneer key can only collect amounts the
 * searcher actually authorised.
 *
 * Requires ORDO_SETTLEMENT_ADDRESS and ORDO_AUCTIONEER_KEY. Without them the
 * auction still runs and records settlement-ready entries for later submission.
 */

const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS as Hex | undefined;
const AUCTIONEER_KEY = normalizePrivateKey(process.env.ORDO_AUCTIONEER_KEY, "ORDO_AUCTIONEER_KEY");
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

const SETTLE_ABI = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "searcher", type: "address" },
          { name: "opportunityId", type: "bytes32" },
          { name: "maxAmountWei", type: "uint256" },
          { name: "chargeWei", type: "uint256" },
          { name: "user", type: "address" },
          { name: "app", type: "address" },
        ],
      },
      { name: "searcherSig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export function settlementEnabled(): boolean {
  return Boolean(SETTLEMENT && AUCTIONEER_KEY);
}

/** Auction opportunity UUID -> bytes32 replay key (must match the SDK). */
export function opportunityIdToBytes32(id: string): Hex {
  return ("0x" + id.replace(/-/g, "").padEnd(64, "0")) as Hex;
}

function asAddress(v: string | undefined): Hex {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Hex) : ZERO;
}

/** Submits settle(); returns the tx hash, or null when settlement isn't possible. */
export async function submitSettlement(rec: SettlementRecord): Promise<string | null> {
  if (!SETTLEMENT || !AUCTIONEER_KEY) return null;
  if (!rec.searcherSig) return null; // searcher never signed an EIP-712 bid

  const account = privateKeyToAccount(AUCTIONEER_KEY);
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(ENDPOINTS.rpc) });

  return wallet.writeContract({
    address: SETTLEMENT,
    abi: SETTLE_ABI,
    functionName: "settle",
    account,
    chain: robinhoodChain,
    args: [
      {
        searcher: asAddress(rec.searcher),
        opportunityId: opportunityIdToBytes32(rec.opportunityId),
        maxAmountWei: BigInt(rec.maxAmountWei),
        chargeWei: BigInt(rec.chargeWei),
        user: asAddress(rec.user),
        app: asAddress(rec.app),
      },
      rec.searcherSig as Hex,
    ],
  });
}
