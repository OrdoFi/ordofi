/**
 * Market caps for the picker.
 *
 * A cap is supply times price, and the picker has neither for most of the
 * chain. Supply is never published anywhere: it comes from `totalSupply()`,
 * and since it moves rarely it is read once an hour. Price the app does
 * publish — for the six hundred tokens that hold a Uniswap V3 pool against a
 * stablecoin. The other eleven thousand, every launchpad coin including ORDO,
 * trade only in V4 hooked pools the app does not read, so they arrive priced
 * `null` and would show no cap at all. Those we price ourselves, from the spot
 * price of the deepest V4 pool they have against ether or USDG — one
 * `getSlot0` on a pool the router has already discovered.
 *
 * Everything here runs on the background RPC lane, which is two slots that a
 * live quote never waits behind, and the answers are folded into the token
 * list the picker already downloads. So a row draws its cap from memory: no
 * amount of scrolling, searching or opening the picker touches the chain.
 *
 * A cap is a claim about a token, and a wrong one is worse than none. Supply
 * that does not answer, a pool with no liquidity, a price of zero or a cap
 * past a trillion dollars are all dropped rather than shown.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { NATIVE, USDG, WETH, limited, poolsFor, type Pool, type Rpc, type V4Source } from "./ordoswap2.js";

type Hex = `0x${string}`;

const STATE_VIEW: Hex = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const SLOT0_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
/** `totalSupply()`. */
const TOTAL_SUPPLY: Hex = "0x18160ddd";

/** Supply barely moves; a token that has answered once need not be asked again for an hour. */
export const SUPPLY_TTL_MS = 60 * 60_000;
/** A cap is an identification aid, not a price feed; a quarter hour stale is invisible in a rounded figure. */
export const SPOT_TTL_MS = 15 * 60_000;
/**
 * Which pool prices a token is worth remembering far longer than the price it
 * gave. Finding it costs eight factory calls and a pool ranking; re-reading it
 * costs one `getSlot0`. Without this, keeping a thousand caps warm would mean
 * ten thousand calls a quarter hour, which is a lot of upstream for a figure
 * nobody trades on.
 */
export const ROUTE_TTL_MS = 6 * 60 * 60_000;
/** Tokens whose cap is worth keeping warm; past this a token sees a few hundred swaps a day. */
export const DEFAULT_TRACKED = 1_200;
/** Past this a "cap" is an artefact of a thin pool against an inflated supply, not a number to print. */
export const MAX_SANE_CAP_USD = 1e12;

export interface Priced {
  address: string;
  decimals: number;
  usd: number | null;
  v4: boolean;
}

/**
 * The price of one whole `token` in whole units of the pool's other side.
 *
 * V4 states a pool as sqrt(currency1 per currency0) in Q64.96. Squaring
 * recovers the raw ratio; the decimal shift turns it from a ratio of smallest
 * units into one of whole tokens, and the side the token sits on decides
 * whether that ratio or its reciprocal is what we asked for.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, decToken: number, decOther: number): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const raw = r * r; // currency1 per currency0, in smallest units
  if (!isFinite(raw) || raw <= 0) return null;
  const [dec0, dec1] = tokenIsCurrency0 ? [decToken, decOther] : [decOther, decToken];
  const oneForOne = raw * 10 ** (dec0 - dec1); // whole currency1 per whole currency0
  if (!isFinite(oneForOne) || oneForOne <= 0) return null;
  const p = tokenIsCurrency0 ? oneForOne : 1 / oneForOne;
  return isFinite(p) && p > 0 ? p : null;
}

/** Ether and WETH are the same money; V4 spells ether as address zero. */
const isEth = (a: string): boolean => a === NATIVE || a === WETH;

/**
 * The pool to price a token from: the deepest V4 pool it has against ether or
 * USDG. `poolsFor` has already ranked them by liquidity and dropped the empty
 * ones, so this is the first that quotes a side we know the dollar value of.
 */
export function pricingPool(pools: Pool[], token: string): Pool | null {
  for (const p of pools) {
    if (p.venue !== "v4" || !p.key) continue;
    if ((p.liquidity ?? 1n) <= 0n) continue;
    const { currency0, currency1 } = p.key;
    const other = currency0 === token ? currency1 : currency1 === token ? currency0 : null;
    if (other === null) continue;
    if (isEth(other) || other === USDG) return p;
  }
  return null;
}

/** Where a token's price comes from, once we have gone to the trouble of finding out. */
interface Route {
  poolId: Hex;
  tokenIsCurrency0: boolean;
  /** Ether, whose dollar price moves, or USDG, which is the dollar. */
  otherIsEther: boolean;
  otherDecimals: number;
  at: number;
}

export class MarketCaps {
  private readonly supply = new Map<string, { v: bigint | null; at: number }>();
  private readonly spot = new Map<string, { usd: number | null; at: number }>();
  private readonly routes = new Map<string, Route | null>();
  private readonly routedAt = new Map<string, number>();
  private readonly caps = new Map<string, number>();
  private running = false;

  constructor(
    private readonly rpc: Rpc,
    private readonly v4: V4Source | null,
  ) {}

  /** The cap of a token in dollars, or null while it is unknown or not worth believing. */
  get(address: string): number | null {
    return this.caps.get(address.toLowerCase()) ?? null;
  }

  size(): number {
    return this.caps.size;
  }

  /**
   * Bring caps up to date for `tokens`, busiest first.
   *
   * Bounded three ways: `limit` tokens a pass, only the ones whose supply or
   * price has actually gone stale, and a handful in flight at a time. The
   * chunking is not about concurrency — the shared background lane already
   * caps that at two — but about not spending a round trip's latency waiting
   * before the next token is even considered. A pass still running when the
   * next falls due is left to finish rather than doubled up.
   */
  async refresh(tokens: Priced[], ethUsd: number | null, limit = DEFAULT_TRACKED, now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const want = tokens.slice(0, limit);
      for (let i = 0; i < want.length; i += 8) {
        await Promise.all(want.slice(i, i + 8).map((t) => this.one(t, ethUsd, now)));
      }
    } finally {
      this.running = false;
    }
  }

  private async one(t: Priced, ethUsd: number | null, now: number): Promise<void> {
    const a = t.address.toLowerCase();
    const usd = t.usd ?? (t.v4 ? await this.spotUsd(a, t.decimals, ethUsd, now) : null);
    if (usd == null || usd <= 0) return;
    const s = await this.supplyOf(a, now);
    if (s == null || s <= 0n) return;
    const cap = (Number(s) / 10 ** t.decimals) * usd;
    if (isFinite(cap) && cap > 0 && cap < MAX_SANE_CAP_USD) this.caps.set(a, cap);
    else this.caps.delete(a);
  }

  private async supplyOf(address: string, now: number): Promise<bigint | null> {
    const hit = this.supply.get(address);
    if (hit && now - hit.at < SUPPLY_TTL_MS) return hit.v;
    let v: bigint | null = null;
    try {
      const r = (await limited(() => this.rpc("eth_call", [{ to: address as Hex, data: TOTAL_SUPPLY }, "latest"]), true)) as Hex;
      if (r && r !== "0x") v = BigInt(r);
    } catch {
      v = null;
    }
    this.supply.set(address, { v, at: now });
    return v;
  }

  /** The dollar price of a token the app could not price, read off its deepest V4 pool. */
  private async spotUsd(address: string, decimals: number, ethUsd: number | null, now: number): Promise<number | null> {
    const hit = this.spot.get(address);
    if (hit && now - hit.at < SPOT_TTL_MS) return hit.usd;
    let usd: number | null = null;
    try {
      const route = await this.routeFor(address, now);
      // Ether needs a dollar price of its own; USDG is the dollar.
      const otherUsd = route ? (route.otherIsEther ? ethUsd : 1) : null;
      if (route && otherUsd != null && otherUsd > 0) {
        const raw = (await limited(
          () => this.rpc("eth_call", [{ to: STATE_VIEW, data: encodeFunctionData({ abi: SLOT0_ABI, functionName: "getSlot0", args: [route.poolId] }) }, "latest"]),
          true,
        )) as Hex;
        const [sqrtPriceX96] = decodeFunctionResult({ abi: SLOT0_ABI, functionName: "getSlot0", data: raw }) as [bigint, number, number, number];
        const inOther = priceFromSqrt(sqrtPriceX96, route.tokenIsCurrency0, decimals, route.otherDecimals);
        if (inOther != null) usd = inOther * otherUsd;
      }
    } catch (e) {
      if (process.env.ORDO_MCAP_DEBUG) console.warn(`mcap | spot ${address}: ${(e as Error).message.split("\n")[0]}`);
      usd = null;
    }
    this.spot.set(address, { usd, at: now });
    return usd;
  }

  /** The pool a token's price is read from — discovered once, then reused for hours. */
  private async routeFor(address: string, now: number): Promise<Route | null> {
    const at = this.routedAt.get(address);
    if (at != null && now - at < ROUTE_TTL_MS) return this.routes.get(address) ?? null;
    let route: Route | null = null;
    const pools = [
      ...(await poolsFor(this.rpc, this.v4, WETH, address as Hex, true)),
      ...(address === USDG ? [] : await poolsFor(this.rpc, this.v4, USDG, address as Hex, true)),
    ];
    const pool = pricingPool(pools, address);
    if (pool?.key) {
      const tokenIsCurrency0 = pool.key.currency0 === address;
      const other = tokenIsCurrency0 ? pool.key.currency1 : pool.key.currency0;
      route = {
        poolId: pool.id.slice("v4:".length) as Hex,
        tokenIsCurrency0,
        otherIsEther: isEth(other),
        // Ether and USDG are the only sides we price against, and we know both.
        otherDecimals: isEth(other) ? 18 : 6,
        at: now,
      };
    }
    this.routes.set(address, route);
    this.routedAt.set(address, now);
    return route;
  }
}
