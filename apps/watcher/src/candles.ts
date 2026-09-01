import { SWAP_TOPICS } from "@ordofi/core";

/**
 * One V3-style swap reduced to what a candle needs. Price is the pool's own
 * post-swap sqrtPriceX96 squared — token1 per token0 in raw units; volumes
 * are raw-unit magnitudes. Decimal scaling and orientation are the reader's
 * job, because only the reader knows which side of the pair it is charting.
 *
 * V2 swaps carry no price in their event and V4 pools live behind poolIds
 * rather than addresses; both are out of scope for the recorded tape.
 */
export interface PricePoint {
  pool: string;
  bucket: number;
  price: number;
  vol0: number;
  vol1: number;
  block: number;
}

const TWO_96 = 2 ** 96;
const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

function absInt256(word: string): bigint {
  const v = BigInt("0x" + word);
  const signed = v >= TWO_255 ? v - TWO_256 : v;
  return signed < 0n ? -signed : signed;
}

/** One V3 swap as the trades tape stores it: raw, exact, orientation-free. */
export interface TradeRow {
  pool: string;
  block: number;
  logIndex: number;
  txHash: string;
  amount0: string;
  amount1: string;
  sqrtPrice: string;
  ts: number;
}

function int256(word: string): bigint {
  const v = BigInt("0x" + word);
  return v >= TWO_255 ? v - TWO_256 : v;
}

export function extractTrades(
  block: number,
  timestamp: number,
  receipts: { transactionHash?: string; logs?: { address: string; topics?: string[]; data?: string; logIndex?: string; transactionHash?: string }[] }[],
): TradeRow[] {
  const out: TradeRow[] = [];
  for (const r of receipts) {
    for (const log of r?.logs ?? []) {
      if (SWAP_TOPICS[log.topics?.[0]?.toLowerCase() ?? ""] !== "univ3") continue;
      const data = (log.data ?? "0x").slice(2);
      if (data.length < 5 * 64) continue;
      out.push({
        pool: log.address.toLowerCase(),
        block,
        logIndex: Number(BigInt(log.logIndex ?? "0x0")),
        txHash: log.transactionHash ?? r.transactionHash ?? "",
        amount0: int256(data.slice(0, 64)).toString(),
        amount1: int256(data.slice(64, 128)).toString(),
        sqrtPrice: BigInt("0x" + data.slice(2 * 64, 3 * 64)).toString(),
        ts: timestamp,
      });
    }
  }
  return out;
}

export function extractPricePoints(
  block: number,
  timestamp: number,
  receipts: { logs?: { address: string; topics?: string[]; data?: string }[] }[],
  bucketSec = 60,
): PricePoint[] {
  const bucket = Math.floor(timestamp / bucketSec) * bucketSec;
  const out: PricePoint[] = [];
  for (const r of receipts) {
    for (const log of r?.logs ?? []) {
      if (SWAP_TOPICS[log.topics?.[0]?.toLowerCase() ?? ""] !== "univ3") continue;
      const data = (log.data ?? "0x").slice(2);
      if (data.length < 5 * 64) continue;
      const sqrt = Number(BigInt("0x" + data.slice(2 * 64, 3 * 64)));
      const price = (sqrt / TWO_96) ** 2;
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({
        pool: log.address.toLowerCase(),
        bucket,
        price,
        vol0: Number(absInt256(data.slice(0, 64))),
        vol1: Number(absInt256(data.slice(64, 128))),
        block,
      });
    }
  }
  return out;
}
