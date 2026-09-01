import { ETH_USD, QUOTE_TOKENS, WETH, rpcFetch } from "./index.ts";

/**
 * Minimal on-chain metadata + USD valuation for tokens.
 *
 * Quote assets (WETH, stablecoins) are valued directly from their USD anchors.
 * Non-quote tokens are intentionally left unpriced here: valuing a long-tail
 * memecoin requires a reliable price path and is a known follow-up. Reporting
 * only quote-denominated value keeps the headline number honest.
 */

const DECIMALS_SIG = "0x313ce567";
const SYMBOL_SIG = "0x95d89b41";
const SLOT0_SIG = "0x3850c7bd";
const TOKEN0_SIG = "0x0dfe1681";

async function ethCall(to: string, data: string): Promise<string> {
  return (await rpcFetch("eth_call", [{ to, data }, "latest"])) as string;
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

/**
 * ETH in dollars, read off the chain rather than assumed.
 *
 * A hardcoded default is wrong the day after it is written and wrong silently:
 * it was 2250 against a real rate of ~2445, so every WETH-denominated figure
 * ran about 9% light and would have drifted further. Set ORDO_ETH_USD to pin
 * it; otherwise it comes from the deepest WETH/stablecoin pool.
 */
const ETH_USD_POOL = (process.env.ORDO_ETH_USD_POOL ?? "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca").toLowerCase();
const ETH_USD_TTL_MS = Number(process.env.ORDO_ETH_USD_TTL_MS ?? 600_000);
// Parsed here rather than reusing the ETH_USD constant, which index.ts fixes
// at its own load time. Empty counts as unset: compose passes
// `${ORDO_ETH_USD:-}` through, so the variable exists but says nothing, and
// reading that as a pin would leave the on-chain price permanently unused.
const ETH_USD_PIN = (() => {
  const raw = process.env.ORDO_ETH_USD;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

let ethUsdCache: { value: number; at: number } | null = null;

export async function ethUsd(): Promise<number> {
  if (ETH_USD_PIN !== null) return ETH_USD_PIN;
  if (ethUsdCache && Date.now() - ethUsdCache.at < ETH_USD_TTL_MS) return ethUsdCache.value;

  try {
    const [slot0, token0] = await Promise.all([
      ethCall(ETH_USD_POOL, SLOT0_SIG),
      ethCall(ETH_USD_POOL, TOKEN0_SIG),
    ]);
    // slot0 packs sqrtPriceX96 into the first word; token0 decides which way
    // round the pair is quoted.
    const sqrt = BigInt("0x" + slot0.slice(2, 66));
    if (sqrt === 0n) throw new Error("pool has no price");
    const wethIsToken0 = ("0x" + token0.slice(26)).toLowerCase() === WETH;

    // (sqrtPriceX96 / 2^96)^2 gives token1 per token0 in raw units; the
    // decimal shift converts that to whole tokens.
    const raw = Number(sqrt * sqrt) / Number(2n ** 192n);
    const price = wethIsToken0 ? raw * 10 ** 12 : (1 / raw) * 10 ** -12;
    if (!Number.isFinite(price) || price <= 0) throw new Error(`implausible price ${price}`);

    ethUsdCache = { value: price, at: Date.now() };
    return price;
  } catch {
    // A price that cannot be read is not a reason to stop reporting; the
    // static anchor is stale but bounded.
    return ETH_USD;
  }
}

export async function getTokenInfo(address: string): Promise<TokenInfo> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  // Symbol and decimals never change; the price does, so it is refreshed even
  // on a cache hit rather than frozen at whatever it was on first sight.
  if (hit) {
    const anchor = QUOTE_TOKENS[key];
    return { ...hit, usdPerToken: anchor === "eth" ? await ethUsd() : hit.usdPerToken };
  }

  let symbol = key.slice(0, 8);
  let decimals = 18;
  let resolved = true;
  try {
    symbol = decodeStringReturn(await ethCall(address, SYMBOL_SIG)) ?? symbol;
  } catch {
    resolved = false;
  }
  try {
    const dec = await ethCall(address, DECIMALS_SIG);
    if (dec && dec !== "0x") decimals = parseInt(dec, 16);
    else resolved = false;
  } catch {
    resolved = false;
  }

  const anchor = QUOTE_TOKENS[key];
  const usdPerToken = anchor === undefined ? null : anchor === "eth" ? await ethUsd() : anchor;

  const info: TokenInfo = { address: key, symbol, decimals, usdPerToken };
  // A throttled RPC must not freeze an address-prefix symbol or the default
  // 18 decimals into the cache — retry on the next ask instead.
  if (resolved) cache.set(key, info);
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
