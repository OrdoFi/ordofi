/**
 * The numbers on rpc.ordofi.network, computed by the thing that serves it.
 *
 * They used to come from app.ordofi.network/api/stats — a second service, on a
 * second origin, reading the same database this process already has open. So
 * the RPC's own front page could only show how much volume the RPC had
 * protected if a different app was up and fast, and this afternoon it was
 * neither: five figures sat on an em dash while the page waited, and the
 * timeout that stopped the page hanging also guaranteed the numbers never
 * arrived.
 *
 * Everything here is a query against the shared index, which the gateway is
 * already connected to. Volume is in dollars because it was priced when the
 * transaction was recorded, so no price feed is involved. The count of
 * arbitrages needs no pricing either. Only the dollar value of observed MEV
 * does, and that one is allowed to be null rather than guessed — a made-up
 * number on a public page is worse than a blank.
 *
 * Read on a timer, served from memory. node:sqlite is synchronous: a query on
 * the request path is a query the whole gateway waits for, which is how the
 * token list took the RPC down this morning.
 */

export interface Store {
  routedTotals(): {
    confirmed: number;
    confirmed24h: number;
    volumeUsd: number;
    volume24hUsd: number;
    firstAt: number | null;
  };
  activeSearchers(sinceSec: number): number;
  pricedProfit(sinceSec?: number): {
    arbs: number;
    pricedArbs: number;
    profitByToken: { token: string; wei: bigint; arbs: number }[];
  };
}

/** Somewhere that knows what a token is worth, when anything does. */
export interface Prices {
  /** USD for one whole token, or null if unknown. */
  usd(token: string): number | null;
  /** Decimals, so wei can be made whole. */
  decimals(token: string): number | null;
}

export interface Headline {
  protectedVolumeUsd: number;
  protectedVolume24hUsd: number;
  transactions: number;
  transactions24h: number;
  activeSearchers24h: number;
  /** Arbitrages the watcher saw land on-chain in the last day. A count, so always available. */
  mevObservedArbs24h: number;
  /** Their value, when the tokens involved can be priced. Null is honest; zero would not be. */
  mevObservedUsd24h: number | null;
  rebateSplit: { user: number; app: number; protocol: number };
  since: number | null;
  at: number;
}

const DAY = 86_400;

export class HeadlineStats {
  private cached: Headline | null = null;
  private running = false;

  constructor(
    private readonly store: Store | null,
    private readonly prices: Prices | null,
    private readonly rebateSplit: { user: number; app: number; protocol: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** The last good reading, or null before the first one. */
  get(): Headline | null {
    return this.cached;
  }

  json(): string {
    return JSON.stringify(this.cached ?? { at: 0, unavailable: true });
  }

  /**
   * One pass over the index. Overlapping passes are skipped rather than queued:
   * these are synchronous reads and two of them cannot help each other.
   */
  refresh(): void {
    if (!this.store || this.running) return;
    this.running = true;
    try {
      const routed = this.store.routedTotals();
      const sinceSec = this.now() / 1000 - DAY;
      const day = this.store.pricedProfit(sinceSec);
      this.cached = {
        protectedVolumeUsd: routed.volumeUsd,
        protectedVolume24hUsd: routed.volume24hUsd,
        transactions: routed.confirmed,
        transactions24h: routed.confirmed24h,
        activeSearchers24h: this.store.activeSearchers(sinceSec),
        mevObservedArbs24h: day.arbs,
        mevObservedUsd24h: this.value(day.profitByToken),
        rebateSplit: this.rebateSplit,
        since: routed.firstAt,
        at: this.now(),
      };
    } catch {
      // A reading we could not take leaves the last one standing.
    } finally {
      this.running = false;
    }
  }

  /**
   * What the observed profit was worth, or null.
   *
   * Null when nothing can be priced at all. When only some tokens can be, the
   * total is a floor rather than nothing — which is what the figure has always
   * been, since profit taken in a token nobody quotes is real and unvalued.
   */
  private value(byToken: { token: string; wei: bigint }[]): number | null {
    if (!this.prices || !byToken.length) return byToken.length ? null : 0;
    let usd = 0;
    let priced = 0;
    for (const p of byToken) {
      const per = this.prices.usd(p.token);
      const dec = this.prices.decimals(p.token);
      if (per === null || dec === null) continue;
      usd += (Number(p.wei) / 10 ** dec) * per;
      priced++;
    }
    if (!priced) return null;
    return Math.round(usd * 100) / 100;
  }
}
