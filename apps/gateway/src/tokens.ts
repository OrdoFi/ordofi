/**
 * The token list behind the swap page's picker.
 *
 * The app indexes every token on the chain (~12k) with symbol, name,
 * decimals, price, icon and which V3 pools it has. The picker needs a compact,
 * ranked version of that with two things added: whether a token is one of
 * Robinhood's tokenized stocks (they get their own tab), and whether Ordo Swap
 * can route it today. The contract swaps through Uniswap V3 only; tokens that
 * live on V4 hooked pools — most launchpad coins — are listed so a search
 * finds them, but marked so the page can say "not yet" instead of failing.
 *
 * Fetched from the app on a timer and kept in memory; the app being down
 * leaves the last list in place rather than an empty picker.
 */

export interface PickerToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: string | null;
  usd: number | null;
  swaps24h: number;
  /** One of Robinhood's tokenized stocks/ETFs. */
  stock: boolean;
  /** Has at least one Uniswap V3 pool against WETH or USDG. */
  v3: boolean;
  /** Has at least one Uniswap V4 pool (any hook), per the watcher's index. */
  v4: boolean;
}

/** Where V4 pools are known from: the shared store, when the gateway has one. */
export interface V4Index {
  v4PoolsFor(currency: string): unknown[];
}

interface AppToken {
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  icon?: string | null;
  usdPerToken?: number | null;
  swaps24h?: number;
  tiers?: { eth?: number[]; usdg?: number[] };
}

const BASES = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"]);

export function isStock(t: AppToken): boolean {
  return /robinhood tok/i.test(t.name ?? "") || (t.icon ?? "").startsWith("https://cdn.robinhood.com/");
}

export function toPicker(list: AppToken[], v4?: V4Index | null): PickerToken[] {
  const out: PickerToken[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    const address = (t.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address) || seen.has(address)) continue;
    if (!t.symbol || typeof t.decimals !== "number") continue;
    seen.add(address);
    let hasV4 = false;
    if (v4) {
      try {
        hasV4 = v4.v4PoolsFor(address).length > 0;
      } catch {
        hasV4 = false;
      }
    }
    out.push({
      address,
      symbol: String(t.symbol).slice(0, 12),
      name: String(t.name ?? t.symbol).replace(/\s*•\s*Robinhood Tok.*$/i, "").slice(0, 60),
      decimals: t.decimals,
      icon: t.icon || null,
      usd: typeof t.usdPerToken === "number" && isFinite(t.usdPerToken) ? t.usdPerToken : null,
      swaps24h: t.swaps24h ?? 0,
      stock: isStock(t),
      // The app's tiers are "pools against WETH / against USDG", so the two
      // bases themselves report none. They are the route, not a destination.
      v3: BASES.has(address) || Boolean(t.tiers?.eth?.length || t.tiers?.usdg?.length),
      v4: BASES.has(address) || hasV4,
    });
  }
  out.sort((a, b) => b.swaps24h - a.swaps24h);
  return out;
}

export class TokenList {
  private tokens: PickerToken[] = [];
  private updatedAt = 0;
  private json = "[]";

  constructor(
    private readonly source: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly v4: V4Index | null = null,
  ) {}

  async refresh(): Promise<void> {
    const r = await this.fetchImpl(this.source, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`token list ${r.status}`);
    const list = (await r.json()) as AppToken[];
    const next = toPicker(list, this.v4);
    if (next.length === 0) return; // an empty answer is a broken source, not an empty chain
    this.tokens = next;
    this.json = JSON.stringify({ updatedAt: Date.now(), tokens: next });
    this.updatedAt = Date.now();
  }

  body(): string {
    return this.json;
  }


  /** The busiest `n` routable tokens, for warming the router's pair cache. */
  top(n: number): string[] {
    return this.tokens.filter((t) => t.v3 || t.v4).slice(0, n).map((t) => t.address);
  }

  age(): number {
    return this.updatedAt ? Date.now() - this.updatedAt : Infinity;
  }

  size(): number {
    return this.tokens.length;
  }
}
