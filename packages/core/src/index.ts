import { defineChain } from "viem";

/** Robinhood Chain (Arbitrum Nitro L2, chain ID 4663). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
});

/**
 * Accepts a private key as MetaMask exports it (no 0x) or as viem wants it
 * (with 0x). Absent or empty returns undefined; present but malformed throws
 * with a message that names the variable, because the alternative was a
 * crash-looping service whose log said only "command failed".
 */
export function normalizePrivateKey(
  value: string | undefined,
  name = "private key",
): `0x${string}` | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(`${name} is not a 32-byte hex key (got ${trimmed.length} chars)`);
  }
  return withPrefix as `0x${string}`;
}

/**
 * Sent on every upstream RPC call. The public endpoint sits behind Cloudflare
 * bot detection that scores undici's default fingerprint poorly — the same
 * server saw curl pass while the services got 403s. An honest, identifying
 * agent string is the cheapest thing that helps, and the decent thing to send
 * regardless.
 */
export const RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "user-agent": "OrdoFi/0.1 (+https://app.ordofi.network)",
} as const;

/**
 * Ordered upstream list. The official endpoint leads because it is the
 * sequencer operator's own; the others are the registry-listed public
 * fallbacks that keep the stack alive while Cloudflare challenges us.
 */
export function rpcUrls(): string[] {
  const raw =
    process.env.ORDO_RPC_URLS ??
    process.env.ORDO_RPC_URL ??
    "https://rpc.mainnet.chain.robinhood.com";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

let rpcId = 0;
let cursor = 0; // sticky: keep using whichever upstream last answered
let cursorLeftPrimaryAt = 0;
/**
 * How long a fallback stays sticky before the primary is tried again. The
 * list is ordered fastest-first; without an expiry one throttled minute on the
 * primary parked every read on the slow public node for the life of the
 * process (two seconds a call, twenty calls a quote).
 */
const FALLBACK_STICKY_MS = 30_000;

// No parameter properties here: apps/web runs under plain Node, whose native
// type-stripping only accepts erasable TypeScript syntax.
class UpstreamRpcError extends Error {
  code: number;
  readonly isRpcLevel = true;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/**
 * Rate limiting arrives as a JSON-RPC error, not a transport failure, so the
 * "a real answer is not a reason to ask someone else" rule got it exactly
 * backwards: being throttled is the one RPC-level error where asking someone
 * else is the entire remedy. Treating it as fatal meant the watcher sat out
 * its backoff against a busy endpoint while a healthy fallback went unused.
 *
 * Capability refusals are the same shape: publicnode answers historical
 * eth_getLogs with "Archive requests require a personal token", which says
 * nothing about the request and everything about that host's retention.
 * Another upstream may simply have the data.
 */
export function isRetryableRpcError(err: unknown): boolean {
  const e = err as { code?: number; message?: string };
  if (e?.code === -32005 || e?.code === 429) return true;
  // Chainstack words its throttle "You've exceeded the RPS limit available on
  // the current plan"; without "rps limit" here that sentence went straight
  // through the gateway to the wallet instead of to the next upstream.
  return /rate.?limit|rps limit|exceeded the .*limit|quota|too many requests|throttl|capacity|try again|archive|personal token/i.test(
    e?.message ?? "",
  );
}

/**
 * JSON-RPC over whichever upstream is currently healthy.
 *
 * Transport failures — 403 challenge pages, timeouts, dead hosts — rotate to
 * the next URL, as do rate limits. Any other JSON-RPC error does not: that is
 * a healthy upstream giving a real answer ("intrinsic gas too low" is not a
 * reason to ask someone else), and it is rethrown with `code` intact.
 */
export async function rpcFetch(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const urls = rpcUrls();
  let lastErr: Error | null = null;
  if (cursor !== 0 && Date.now() - cursorLeftPrimaryAt > FALLBACK_STICKY_MS) cursor = 0;
  for (let i = 0; i < urls.length; i++) {
    const idx = (cursor + i) % urls.length;
    const url = urls[idx];
    try {
      const result = await rpcOnce(url, method, params, opts?.timeoutMs);
      // Only a genuine answer makes an upstream sticky. Setting this before
      // checking body.error pinned the cursor to whichever endpoint was busy
      // throttling us.
      if (idx !== 0 && cursor === 0) cursorLeftPrimaryAt = Date.now();
      cursor = idx;
      return result;
    } catch (e) {
      if ((e as UpstreamRpcError).isRpcLevel && !isRetryableRpcError(e)) throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("no RPC upstream configured");
}

/** One JSON-RPC call to one URL; throws UpstreamRpcError for RPC-level errors. */
export async function rpcOnce(url: string, method: string, params: unknown[], timeoutMs = 20_000): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: RPC_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON from ${new URL(url).host} (rate limit or bot challenge)`);
  }
  if (body.error) {
    throw new UpstreamRpcError(body.error.message ?? "upstream error", body.error.code ?? -32000);
  }
  return body.result;
}

/**
 * Where signed transactions go. Reads may fan out across any provider, but a
 * raw transaction is the one thing a third party should never see before the
 * sequencer does, so sends go to the sequencer operator's own endpoint and
 * nowhere else unless that endpoint is unreachable — in which case the caller
 * is told, so the fallback is visible rather than silent.
 */
export function sequencerUrl(): string {
  return process.env.ORDO_SEQUENCER_URL ?? "https://rpc.mainnet.chain.robinhood.com";
}

export async function sendRawTransaction(
  rawTx: string,
  opts?: { timeoutMs?: number; onFallback?: (reason: string) => void },
): Promise<string> {
  try {
    return (await rpcOnce(sequencerUrl(), "eth_sendRawTransaction", [rawTx], opts?.timeoutMs)) as string;
  } catch (e) {
    // A real answer from the sequencer (bad nonce, underpriced, insufficient
    // funds) is final. Only transport failures and throttling fall through.
    if ((e as UpstreamRpcError).isRpcLevel && !isRetryableRpcError(e)) throw e;
    opts?.onFallback?.((e as Error).message);
    return (await rpcFetch("eth_sendRawTransaction", [rawTx], opts)) as string;
  }
}

export const ENDPOINTS = {
  rpc: process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  sequencerFeed:
    process.env.ORDO_FEED_URL ?? "wss://feed.mainnet.chain.robinhood.com",
} as const;

/**
 * Quote/base assets on Robinhood Chain, discovered on-chain by observing which
 * tokens route through the majority of arbitrages. USD anchors: stablecoins = $1,
 * WETH = ORDO_ETH_USD (configurable; defaults to a recent observed ETH price).
 */
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/**
 * Static fallback only. `ethUsd()` in pricing.ts reads the live rate off the
 * chain; this is what it falls back to when that read fails. Number("") is 0,
 * so an empty variable has to be treated as unset or every WETH figure becomes
 * worthless rather than merely stale.
 */
export const ETH_USD = (() => {
  const raw = process.env.ORDO_ETH_USD;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2450;
})();

/** address (lowercase) -> USD value of 1 whole token, or "eth" to use ETH_USD. */
export const QUOTE_TOKENS: Record<string, number | "eth"> = {
  [WETH]: "eth",
  [USDG]: 1,
  // Common stables if/when they appear on-chain:
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 1, // USDC (Arbitrum canonical)
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 1, // USDT (Arbitrum canonical)
};

export function isQuoteToken(addr: string): boolean {
  return addr.toLowerCase() in QUOTE_TOKENS;
}

/**
 * DEX swap event topic0 hashes. We identify swaps by event signature rather
 * than by hardcoded pool addresses, so the watcher works against any
 * Uniswap-style deployment on the chain (Uniswap, Arcus, forks) and learns
 * pool addresses as it observes them.
 */
export const SWAP_TOPICS: Record<string, string> = {
  // Swap(address,uint256,uint256,uint256,uint256,address) — Uniswap V2 / forks
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822": "univ2",
  // Swap(address,address,int256,int256,uint160,uint128,int24) — Uniswap V3 / forks
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": "univ3",
  // Swap(PoolId,address,int128,int128,uint160,uint128,int24,uint24) — Uniswap V4
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f": "univ4",
};

/** Transfer(address,address,uint256) — ERC-20 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Uniswap V4 on Robinhood Chain. V4 is a singleton: every pool lives inside
 * the PoolManager and is identified by a bytes32 PoolId (the hash of its
 * PoolKey) rather than by an address of its own. Positions are ERC-721s
 * minted by the PositionManager; StateView is the read lens for slot0 and
 * liquidity; Permit2 is how the PositionManager pulls ERC-20s.
 */
export const V4 = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  /** First block with PoolManager code; nothing V4 exists before it. */
  deployBlock: 9070,
  /** Native ETH as a V4 currency is address zero, never WETH. */
  nativeCurrency: "0x0000000000000000000000000000000000000000",
  // Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1,
  //            uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
  initializeTopic: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  // Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1,
  //      uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
  swapTopic: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  /** LP fee value that marks a hook-controlled, dynamic fee. */
  dynamicFeeFlag: 0x800000,
  /**
   * Ordo's own V4 contracts on Robinhood Chain. The ladder manager mints
   * shaped liquidity through the PositionManager; the stake factory attaches
   * a full-range vault + farm to hookless ETH pools and owns the zap.
   */
  // Second deployment: the first approved Permit2 for the exact token amount,
  // which Solady tokens refuse (their Permit2 allowance is fixed at infinity).
  ladderManager: "0x2b0e53c9f869de1fe7c5b43abaabaa90e23c073b",
  ladderDeployBlock: 52_996_505,
  stakeFactory: "0x9a4a6420c027a0bafa0a55464196cf5d966122d2",
  stakeZap: "0xfbf1ad9bd14aa0353d753b2cdd5536b41a8c786a",
  stakeDeployBlock: 52_996_797,
  /** The V4 ETH pool: native ETH / USDG, 0.01%, tick spacing 1, no hook. */
  ethUsdgPoolId: "0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e",
} as const;

/** A V4 PoolId is 32 bytes; a V2/V3 pool key is a 20-byte address. */
export function isV4PoolId(key: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(key);
}

export interface SwapObservation {
  block: number;
  timestamp: number;
  txHash: string;
  txIndex: number;
  /** The pool's address for V2/V3; for V4 the PoolId, since the emitter is always the PoolManager. */
  pool: string;
  kind: string; // univ2 | univ3 | univ4
}

export interface ArbObservation {
  block: number;
  timestamp: number;
  txHash: string;
  txIndex: number;
  sender: string;
  poolsTouched: string[];
  /** Net ERC-20 flows to the tx sender/executor, by token address (wei, signed). */
  netFlows: Record<string, string>;
  /** Profit denomination: prefers a quote token (WETH/stable) when available. */
  profitToken?: string;
  profitWei?: string;
  /** True when profitToken is a recognized quote asset (WETH/stablecoin). */
  profitIsQuote?: boolean;
  gasPaidWei: string;
}

export interface BlockSummary {
  block: number;
  timestamp: number;
  txCount: number;
  swapCount: number;
  arbCount: number;
}
