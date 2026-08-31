import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuctionResult, Bid, LedgerEntry } from "./types.js";

/**
 * Rebate accounting. Auction proceeds are split between the user whose order
 * created the value, the app that routed the flow, and the protocol.
 *
 * Phase 1 records these as owed balances (off-chain accounting). On-chain
 * settlement — where searchers actually pay into a contract that pays out
 * rebates — lands with the Phase 2 settlement contract; the split math and
 * attribution are already final here.
 */
export const REBATE_SPLIT = {
  user: Number(process.env.ORDO_REBATE_USER ?? 0.9),
  app: Number(process.env.ORDO_REBATE_APP ?? 0.05),
  protocol: Number(process.env.ORDO_REBATE_PROTOCOL ?? 0.05),
};

export class RebateLedger {
  private owedByAddress = new Map<string, bigint>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.replay();
  }

  private replay(): void {
    try {
      for (const line of readFileSync(this.file, "utf8").trim().split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as LedgerEntry;
        if (e.appRebateAddress) this.credit(e.appRebateAddress, BigInt(e.splits.appWei));
      }
    } catch {
      /* fresh ledger */
    }
  }

  private credit(addr: string, wei: bigint): void {
    const a = addr.toLowerCase();
    this.owedByAddress.set(a, (this.owedByAddress.get(a) ?? 0n) + wei);
  }

  record(result: AuctionResult, winningBid: Bid, appRebateAddress?: string): LedgerEntry {
    const total = BigInt(result.clearingPriceWei);
    const userWei = (total * BigInt(Math.round(REBATE_SPLIT.user * 1000))) / 1000n;
    const appWei = (total * BigInt(Math.round(REBATE_SPLIT.app * 1000))) / 1000n;
    const protocolWei = total - userWei - appWei;

    const entry: LedgerEntry = {
      opportunityId: result.opportunityId,
      at: Date.now(),
      totalWei: total.toString(),
      splits: {
        userWei: userWei.toString(),
        appWei: appWei.toString(),
        protocolWei: protocolWei.toString(),
      },
      appRebateAddress,
      searcher: winningBid.searcher,
    };

    if (appRebateAddress) this.credit(appRebateAddress, appWei);
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }

  balances(): Record<string, string> {
    return Object.fromEntries([...this.owedByAddress].map(([k, v]) => [k, v.toString()]));
  }
}
