import {
  isQuoteToken,
  SWAP_TOPICS,
  TRANSFER_TOPIC,
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

    // Compute net ERC-20 flows per (address, token) across the whole tx. The
    // searcher's realized profit is the largest net-positive balance in a quote
    // asset (WETH/stablecoin) held by any address that is NOT one of the pools
    // being arbitraged — this captures profit wherever the bot books it (its
    // EOA, an executor contract, or a tip recipient), which a sender-only
    // heuristic misses.
    const perAddr = new Map<string, Map<string, bigint>>();
    // Sender-centric net flows retained for the record (inventory/token arbs).
    const beneficiaries = new Set([r.from.toLowerCase()]);
    if (r.to) beneficiaries.add(r.to.toLowerCase());
    const senderNet = new Map<string, bigint>();

    const bump = (addr: string, token: string, delta: bigint) => {
      let m = perAddr.get(addr);
      if (!m) perAddr.set(addr, (m = new Map()));
      m.set(token, (m.get(token) ?? 0n) + delta);
    };

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
      bump(to, token, amount);
      bump(from, token, -amount);
      if (beneficiaries.has(to)) senderNet.set(token, (senderNet.get(token) ?? 0n) + amount);
      if (beneficiaries.has(from)) senderNet.set(token, (senderNet.get(token) ?? 0n) - amount);
    }

    // Best quote-denominated profit across non-pool, non-zero addresses.
    const ZERO = "0x0000000000000000000000000000000000000000";
    let bestQuoteToken: string | undefined;
    let bestQuoteWei = 0n;
    for (const [addr, tokens] of perAddr) {
      if (pools.has(addr) || addr === ZERO) continue;
      for (const [token, v] of tokens) {
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
