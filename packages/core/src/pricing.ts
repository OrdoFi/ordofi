import { ENDPOINTS, ETH_USD, QUOTE_TOKENS, RPC_HEADERS } from "./index.js";

/**
 * Minimal on-chain metadata + USD valuation for tokens.
 *
 * Quote assets (WETH, stablecoins) are valued directly from their USD anchors.
 * Non-quote tokens are intentionally left unpriced here: valuing a long-tail
 * memecoin requires a reliable price path and is a known follow-up. Reporting
 * only quote-denominated value keeps the headline number honest.
 */

const RPC = ENDPOINTS.rpc;
const DECIMALS_SIG = "0x313ce567";
const SYMBOL_SIG = "0x95d89b41";

let rpcId = 0;
async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: RPC_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result ?? "0x";
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  /** USD value of one whole token, or null when not a recognized quote asset. */
  usdPerToken: number | null;
}

const cache = new Map<string, TokenInfo>();

function decodeStringReturn(hex: string): string | null {
  if (!hex || hex === "0x") return null;
  const data = hex.slice(2);
  try {
    if (data.length >= 128) {
      const len = parseInt(data.slice(64, 128), 16);
      if (len > 0 && len <= 64) {
        return Buffer.from(data.slice(128, 128 + len * 2), "hex")
          .toString("utf8")
          .replace(/\0+$/, "");
      }
    }
    return Buffer.from(data.slice(0, 64), "hex").toString("utf8").replace(/\0+$/, "") || null;
  } catch {
    return null;
  }
}

export async function getTokenInfo(address: string): Promise<TokenInfo> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  let symbol = key.slice(0, 8);
  let decimals = 18;
  try {
    symbol = decodeStringReturn(await ethCall(address, SYMBOL_SIG)) ?? symbol;
  } catch {
    /* fallback */
  }
  try {
    const dec = await ethCall(address, DECIMALS_SIG);
    if (dec && dec !== "0x") decimals = parseInt(dec, 16);
  } catch {
    /* fallback */
  }

  const anchor = QUOTE_TOKENS[key];
  const usdPerToken = anchor === undefined ? null : anchor === "eth" ? ETH_USD : anchor;

  const info: TokenInfo = { address: key, symbol, decimals, usdPerToken };
  cache.set(key, info);
  return info;
}

export function toWhole(wei: bigint, decimals: number): number {
  if (decimals <= 0) return Number(wei);
  const neg = wei < 0n;
  const s = (neg ? -wei : wei).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals, s.length - decimals + 8);
  const v = Number(`${whole}.${frac}`);
  return neg ? -v : v;
}

/** USD value of a raw token amount, or null if the token isn't a quote asset. */
export async function usdValue(token: string, wei: bigint): Promise<number | null> {
  const info = await getTokenInfo(token);
  if (info.usdPerToken === null) return null;
  return toWhole(wei, info.decimals) * info.usdPerToken;
}
