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

class UpstreamRpcError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
  readonly isRpcLevel = true;
}

/**
 * JSON-RPC over whichever upstream is currently healthy.
 *
 * Transport failures — 403 challenge pages, timeouts, dead hosts — rotate to
 * the next URL. A JSON-RPC *error* does not: that is a healthy upstream giving
 * a real answer ("intrinsic gas too low" is not a reason to ask someone else),
 * and it is rethrown with `code` intact.
 */
export async function rpcFetch(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const urls = rpcUrls();
  let lastErr: Error | null = null;
  for (let i = 0; i < urls.length; i++) {
    const idx = (cursor + i) % urls.length;
    const url = urls[idx];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: RPC_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
      });
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status} non-JSON from ${new URL(url).host} (rate limit or bot challenge)`);
      }
      cursor = idx;
      if (body.error) {
        throw new UpstreamRpcError(body.error.message ?? "upstream error", body.error.code ?? -32000);
      }
      return body.result;
    } catch (e) {
      if ((e as UpstreamRpcError).isRpcLevel) throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("no RPC upstream configured");
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

export const ETH_USD = Number(process.env.ORDO_ETH_USD ?? 2250);

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

export interface SwapObservation {
  block: number;
  timestamp: number;
  txHash: string;
  txIndex: number;
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
