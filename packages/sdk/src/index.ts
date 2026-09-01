import { WebSocket } from "ws";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  type Account,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "@ordofi/core";

/**
 * @ordofi/sdk — the searcher and app SDK for OrdoFi.
 *
 * Searchers use `OrdoSearcher` to connect to the auction, receive opportunity
 * hints, sign EIP-712 bids, and submit backruns. Apps use `submitOrderFlow` to
 * route user transactions through the auction and earn rebates.
 */

export interface OpportunityHint {
  id: string;
  hint: {
    poolsTouched: string[];
    to: string | null;
    selector: string | null;
    value: string;
  };
  originLabel: string;
}

export interface SearcherConfig {
  /** Auction WebSocket URL, e.g. wss://auction.ordofi.network/searcher */
  auctionWsUrl: string;
  /** Searcher private key (used to sign EIP-712 bids and backrun txs). */
  privateKey: Hex;
  /** Deployed OrdoSettlement address, for EIP-712 domain. */
  settlementAddress: Hex;
  /** Called for each opportunity; return a bid or null to skip. */
  onOpportunity: (
    opp: OpportunityHint,
    ctx: { account: Account },
  ) => Promise<{ maxBidWei: bigint; backrunRawTx: Hex } | null>;
  chainId?: number;
}

const BID_TYPES = {
  Bid: [
    { name: "searcher", type: "address" },
    { name: "opportunityId", type: "bytes32" },
    { name: "maxAmountWei", type: "uint256" },
  ],
} as const;

/** UUID (auction opportunity id) -> bytes32 for EIP-712 signing / on-chain use. */
export function opportunityIdToBytes32(id: string): Hex {
  const hex = id.replace(/-/g, "");
  return ("0x" + hex.padEnd(64, "0")) as Hex;
}

export class OrdoSearcher {
  private ws?: WebSocket;
  readonly account: Account;
  private cfg: SearcherConfig;

  constructor(cfg: SearcherConfig) {
    this.cfg = cfg;
    this.account = privateKeyToAccount(cfg.privateKey);
  }

  get address(): Hex {
    return this.account.address;
  }

  /** Sign an EIP-712 bid authorizing payment up to maxAmountWei for an opportunity. */
  async signBid(opportunityId: string, maxAmountWei: bigint): Promise<Hex> {
    const wallet = createWalletClient({ account: this.account, chain: robinhoodChain, transport: http() });
    return wallet.signTypedData({
      account: this.account,
      domain: {
        name: "OrdoSettlement",
        version: "1",
        chainId: BigInt(this.cfg.chainId ?? robinhoodChain.id),
        verifyingContract: this.cfg.settlementAddress,
      },
      types: BID_TYPES,
      primaryType: "Bid",
      message: {
        searcher: this.account.address,
        opportunityId: opportunityIdToBytes32(opportunityId),
        maxAmountWei,
      },
    });
  }

  /** Connect to the auction and start bidding using the configured strategy. */
  connect(): void {
    const ws = new WebSocket(this.cfg.auctionWsUrl);
    this.ws = ws;

    ws.on("open", () => console.log(`[ordo-sdk] connected as ${this.address}`));
    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "opportunity") return;

      const decision = await this.cfg.onOpportunity(msg.opportunity, { account: this.account });
      if (!decision) return;

      const bidSig = await this.signBid(msg.opportunity.id, decision.maxBidWei);
      ws.send(
        JSON.stringify({
          type: "bid",
          opportunityId: msg.opportunity.id,
          searcher: this.address,
          bidWei: decision.maxBidWei.toString(),
          backrunRawTx: decision.backrunRawTx,
          bidSig,
        }),
      );
    });
    ws.on("close", () => console.log("[ordo-sdk] disconnected"));
    ws.on("error", (e) => console.error("[ordo-sdk] ws error", (e as Error).message));
  }

  close(): void {
    this.ws?.close();
  }
}

/** App-side helper: route a user transaction through the OrdoFi auction. */
export async function submitOrderFlow(
  gatewayOrAuctionUrl: string,
  params: { rawTx: Hex; originLabel: string; rebateAddress?: Hex },
): Promise<any> {
  const res = await fetch(`${gatewayOrAuctionUrl.replace(/\/$/, "")}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

export const SETTLEMENT_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "withdrawBond",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "bond",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Searcher bond management against the deployed OrdoSettlement contract. */
export class OrdoBond {
  private account: Account;
  private settlement: Hex;
  private rpcUrl?: string;

  constructor(privateKey: Hex, settlementAddress: Hex, rpcUrl?: string) {
    this.account = privateKeyToAccount(privateKey);
    this.settlement = settlementAddress;
    this.rpcUrl = rpcUrl;
  }

  async deposit(amountEth: string): Promise<Hex> {
    const wallet = createWalletClient({ account: this.account, chain: robinhoodChain, transport: http(this.rpcUrl) });
    return wallet.writeContract({
      address: this.settlement,
      abi: SETTLEMENT_ABI,
      functionName: "deposit",
      value: parseEther(amountEth),
      account: this.account,
      chain: robinhoodChain,
    });
  }

  async claim(): Promise<Hex> {
    const wallet = createWalletClient({ account: this.account, chain: robinhoodChain, transport: http(this.rpcUrl) });
    return wallet.writeContract({
      address: this.settlement,
      abi: SETTLEMENT_ABI,
      functionName: "claim",
      account: this.account,
      chain: robinhoodChain,
    });
  }

  async bondOf(searcher: Hex): Promise<bigint> {
    const pub = createPublicClient({ chain: robinhoodChain, transport: http(this.rpcUrl) });
    return pub.readContract({ address: this.settlement, abi: SETTLEMENT_ABI, functionName: "bond", args: [searcher] });
  }

  async claimableOf(addr: Hex): Promise<bigint> {
    const pub = createPublicClient({ chain: robinhoodChain, transport: http(this.rpcUrl) });
    return pub.readContract({ address: this.settlement, abi: SETTLEMENT_ABI, functionName: "claimable", args: [addr] });
  }
}
