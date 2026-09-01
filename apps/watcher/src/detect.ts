import {
  isQuoteToken,
  SWAP_TOPICS,
  TRANSFER_TOPIC,
  WETH,
  type ArbObservation,
  type SwapObservation,
} from "@ordofi/core";

interface Log {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  transactionIndex: string | number;
  logIndex: string | number;
}

interface Receipt {
  transactionHash: string;
  transactionIndex: string | number;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice?: string;
  status: string;
  logs: Log[];
}

const toNum = (v: string | number) =>
  typeof v === "number" ? v : parseInt(v, 16);

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(26)).toLowerCase();
}

export interface BlockAnalysis {
  swaps: SwapObservation[];
  arbs: ArbObservation[];
}

/**
 * Analyze one block's receipts.
 *
 * - A "swap" is any log whose topic0 matches a known Uniswap-style Swap event.
 * - An "arb" is a successful tx touching >= 2 distinct pools whose sender ends
 *   the tx with a positive net balance in some token. Net flows are computed
 *   from ERC-20 Transfer logs where the tx sender (or the `to` contract, i.e.
 *   the searcher's executor bot) is a party. This is the standard heuristic
 *   for measuring atomic arbitrage already being captured on-chain.
 */
export function analyzeBlock(
  blockNumber: number,
  timestamp: number,
  receipts: Receipt[],
  /**
   * Native ETH sent with each transaction, by hash. Receipts do not carry it,
   * and without it a trade that pays in ETH looks like it paid nothing: one
   * mainnet transaction sent 68 ETH and received 166,832 USDG, and was booked
   * as $166,832 of extracted value rather than the roughly break-even swap it
   * was. Counted as WETH, since for this purpose they are the same asset.
   */
  txValues?: Map<string, bigint>,
): BlockAnalysis {
  const swaps: SwapObservation[] = [];
  const arbs: ArbObservation[] = [];

  for (const r of receipts) {
    if (toNum(r.status) !== 1) continue;

    const pools = new Set<string>();
    for (const log of r.logs) {
      const kind = SWAP_TOPICS[log.topics[0]?.toLowerCase() ?? ""];
      if (!kind) continue;
      const pool = log.address.toLowerCase();
      pools.add(pool);
      swaps.push({
        block: blockNumber,
        timestamp,
        txHash: r.transactionHash,
        txIndex: toNum(r.transactionIndex),
        pool,
        kind,
      });
    }

    if (pools.size < 2) continue;

    // Net ERC-20 flows for the parties that could actually be the searcher:
    // the sender and the contract it called (its executor).
    //
    // This deliberately does NOT scan every address in the transaction for a
    // net-positive quote balance. That reads any multi-pool swap's *recipient*
    // as a profiting searcher, so an ordinary user routing token -> USDG
    // through two pools has their entire swap output booked as extracted MEV.
    // Measured against mainnet that inflated the chain-wide figure to roughly
    // $150M a day. Profit booked to an address neither sent from nor called is
    // now missed instead, which undercounts — the right direction for a number
    // published as a floor.
    const beneficiaries = new Set([r.from.toLowerCase()]);
    if (r.to) beneficiaries.add(r.to.toLowerCase());
    const senderNet = new Map<string, bigint>();

    for (const log of r.logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (log.topics.length < 3) continue; // ERC-721 style, skip
      const token = log.address.toLowerCase();
      const from = topicToAddress(log.topics[1]);
      const to = topicToAddress(log.topics[2]);
      let amount: bigint;
      try {
        amount = BigInt(log.data === "0x" ? 0 : log.data);
      } catch {
        continue;
      }
      if (beneficiaries.has(to)) senderNet.set(token, (senderNet.get(token) ?? 0n) + amount);
      if (beneficiaries.has(from)) senderNet.set(token, (senderNet.get(token) ?? 0n) - amount);
    }

    const nativeSpent = txValues?.get(r.transactionHash.toLowerCase()) ?? 0n;
    if (nativeSpent > 0n) senderNet.set(WETH, (senderNet.get(WETH) ?? 0n) - nativeSpent);

    // A closed loop ends holding more of something and less of nothing: every
    // leg is bought and sold within the transaction, so intermediate tokens
    // net to zero and only the profit remains. If the sender is down on
    // anything, they paid for the position rather than arbitraged it.
    //
    // Checking only quote assets was not enough. Someone selling a tokenised
    // stock for USDG is down SPY and up USDG, and with SPY unchecked the whole
    // sale was booked as extracted value — most of a $45M/day chain-wide
    // figure. Dust from rounding can now cost a real arb its price, which
    // undercounts, and that is the right direction for a floor.
    let soldSomething = false;
    for (const v of senderNet.values()) {
      if (v < 0n) {
        soldSomething = true;
        break;
      }
    }

    // Best quote-denominated profit the searcher itself ends up holding.
    let bestQuoteToken: string | undefined;
    let bestQuoteWei = 0n;
    if (!soldSomething) {
      for (const [token, v] of senderNet) {
        if (!isQuoteToken(token)) continue;
        if (v > bestQuoteWei) {
          bestQuoteWei = v;
          bestQuoteToken = token;
        }
      }
    }

    // Fallback: sender-centric pure-positive token arb (unpriced inventory).
    const senderPositive = [...senderNet.entries()].filter(([, v]) => v > 0n);
    const senderNegative = [...senderNet.entries()].filter(([, v]) => v < 0n);
    senderPositive.sort((a, b) => (b[1] > a[1] ? 1 : -1));

    // An arb is a >=2-pool tx that yields a positive quote profit to some party,
    // or (weaker) leaves the sender purely net-positive in a token.
    const hasQuoteProfit = bestQuoteToken !== undefined && bestQuoteWei > 0n;
    const hasTokenProfit = senderPositive.length >= 1 && senderNegative.length === 0;
    if (!hasQuoteProfit && !hasTokenProfit) continue;

    const gasUsed = BigInt(r.gasUsed);
    const gasPrice = BigInt(r.effectiveGasPrice ?? "0x0");

    const profitToken = hasQuoteProfit ? bestQuoteToken : senderPositive[0]?.[0];
    const profitWei = hasQuoteProfit ? bestQuoteWei : senderPositive[0]?.[1];

    arbs.push({
      block: blockNumber,
      timestamp,
      txHash: r.transactionHash,
      txIndex: toNum(r.transactionIndex),
      sender: r.from.toLowerCase(),
      poolsTouched: [...pools],
      netFlows: Object.fromEntries([...senderNet.entries()].map(([t, v]) => [t, v.toString()])),
      profitToken,
      profitWei: profitWei?.toString(),
      profitIsQuote: hasQuoteProfit,
      gasPaidWei: (gasUsed * gasPrice).toString(),
    });
  }

  return { swaps, arbs };
}
