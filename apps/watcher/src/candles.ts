import { SWAP_TOPICS, V4 } from "@ordofi/core";

/**
 * One swap reduced to what a candle needs. Price is the pool's own post-swap
 * sqrtPriceX96 squared — token1 per token0 in raw units; volumes are raw-unit
 * magnitudes. Decimal scaling and orientation are the reader's job, because
 * only the reader knows which side of the pair it is charting.
 *
 * V3 pools are keyed by their address. V4 pools all live inside the
 * PoolManager, so they are keyed by the PoolId the Swap log carries in its
 * first topic; the reader turns that back into a pair through the Initialize
 * events the watcher records alongside. V2 swaps carry no price in their
 * event and stay out of the tape.
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

/** One swap as the trades tape stores it: raw, exact, orientation-free. */
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

interface SwapLog {
  address: string;
  topics?: string[];
  data?: string;
  logIndex?: string;
  transactionHash?: string;
}

/**
 * The parts of a Swap log that both tapes need, or null when the log is not
 * a priced swap we record.
 *
 * V3: Swap(sender, recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
 *     amounts are the pool's delta — positive means the pool received it.
 * V4: Swap(PoolId id, sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
 *     amounts are the swapper's delta, the opposite sign. They are flipped
 *     here so every row in the tape reads the same way. Only the canonical
 *     PoolManager's logs count: a PoolId is meaningless without the contract
 *     whose Initialize events name it.
 */
function pricedSwap(log: SwapLog): { pool: string; amount0: bigint; amount1: bigint; sqrt: bigint } | null {
  const kind = SWAP_TOPICS[log.topics?.[0]?.toLowerCase() ?? ""];
  const data = (log.data ?? "0x").slice(2);
  if (kind === "univ3") {
    if (data.length < 5 * 64) return null;
    return {
      pool: log.address.toLowerCase(),
      amount0: int256(data.slice(0, 64)),
      amount1: int256(data.slice(64, 128)),
      sqrt: BigInt("0x" + data.slice(2 * 64, 3 * 64)),
    };
  }
  if (kind === "univ4") {
    if (log.address.toLowerCase() !== V4.poolManager) return null;
    const id = log.topics?.[1];
    if (!id || id.length !== 66 || data.length < 6 * 64) return null;
    return {
      pool: id.toLowerCase(),
      amount0: -int256(data.slice(0, 64)),
      amount1: -int256(data.slice(64, 128)),
      sqrt: BigInt("0x" + data.slice(2 * 64, 3 * 64)),
    };
  }
  return null;
}

export function extractTrades(
  block: number,
  timestamp: number,
  receipts: { transactionHash?: string; logs?: SwapLog[] }[],
): TradeRow[] {
  const out: TradeRow[] = [];
  for (const r of receipts) {
    for (const log of r?.logs ?? []) {
      const s = pricedSwap(log);
      if (!s) continue;
      out.push({
        pool: s.pool,
        block,
        logIndex: Number(BigInt(log.logIndex ?? "0x0")),
        txHash: log.transactionHash ?? r.transactionHash ?? "",
        amount0: s.amount0.toString(),
        amount1: s.amount1.toString(),
        sqrtPrice: s.sqrt.toString(),
        ts: timestamp,
      });
    }
  }
  return out;
}

export function extractPricePoints(
  block: number,
  timestamp: number,
  receipts: { logs?: SwapLog[] }[],
  bucketSec = 60,
): PricePoint[] {
  const bucket = Math.floor(timestamp / bucketSec) * bucketSec;
  const out: PricePoint[] = [];
  for (const r of receipts) {
    for (const log of r?.logs ?? []) {
      const s = pricedSwap(log);
      if (!s) continue;
      const price = (Number(s.sqrt) / TWO_96) ** 2;
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({
        pool: s.pool,
        bucket,
        price,
        vol0: Number(s.amount0 < 0n ? -s.amount0 : s.amount0),
        vol1: Number(s.amount1 < 0n ? -s.amount1 : s.amount1),
        block,
      });
    }
  }
  return out;
}
