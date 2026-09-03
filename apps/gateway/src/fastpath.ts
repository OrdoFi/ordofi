/**
 * The fast path: everything a request can be answered with before, or instead
 * of, a round trip to an upstream.
 *
 * Measured on the public endpoints from the gateway's own host, one upstream
 * call costs ~50 ms at the median and close to a second at p99. Wallets spend
 * most of their calls on things that never change (eth_chainId, net_version)
 * or change every 100 ms block (eth_blockNumber, fee data), and many wallets
 * ask the same question in the same instant. None of that needs to leave the
 * process:
 *
 *   - static answers: chain id and network id are constants of this deployment;
 *   - a micro-cache: a TTL no longer than a block for head-relative reads, a
 *     few seconds for fee data, and forever (bounded) for mined receipts and
 *     transactions, which cannot change once they exist;
 *   - coalescing: concurrent identical requests share one upstream call;
 *   - hedging: an idempotent read that has not answered within a budget is
 *     re-issued to the next upstream and the first answer wins, which turns
 *     the p99 into roughly the p95 at the cost of a few percent more upstream
 *     traffic.
 *
 * Nothing here applies to sends. A signed transaction goes through the
 * protected path exactly once.
 */

/** Millisecond block time on Robinhood Chain; a cache this short is exact enough for any wallet. */
export const BLOCK_MS = 100;

const HEAD_TAGS = new Set(["latest", "pending", "safe", "finalized"]);

/** Reads that may be issued twice without changing anything. */
export const IDEMPOTENT_READS = new Set([
  "eth_blockNumber",
  "eth_chainId",
  "net_version",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockReceipts",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_syncing",
  "web3_clientVersion",
]);

/** Answers that are constants of this deployment and never need an upstream. */
export function staticAnswer(method: string, chainId: number): unknown | undefined {
  switch (method) {
    case "eth_chainId":
      return "0x" + chainId.toString(16);
    case "net_version":
      return String(chainId);
    default:
      return undefined;
  }
}

/**
 * How long a result for this call may be reused, in ms, or 0 for "do not cache".
 * `result` is consulted for the calls whose cacheability depends on the answer:
 * a receipt that does not exist yet must be asked for again.
 */
export function cacheTtlMs(method: string, params: unknown[], result?: unknown): number {
  switch (method) {
    case "eth_blockNumber":
      return BLOCK_MS;
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
    case "eth_feeHistory":
      return 1_000;
    case "eth_getBlockByNumber": {
      const tag = String(params[0] ?? "latest").toLowerCase();
      // A numbered block is immutable once it exists; the head moves every block.
      return HEAD_TAGS.has(tag) ? BLOCK_MS : result == null ? 0 : 60_000;
    }
    case "eth_getBlockByHash":
      return result == null ? 0 : 60_000;
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      // Mined is mined. Pollers ask every few seconds until it lands, then
      // several of them ask again; the first answer serves all of them.
      return result == null ? 0 : 10 * 60_000;
    default:
      return 0;
  }
}

export function cacheKey(method: string, params: unknown[]): string {
  return method + ":" + JSON.stringify(params ?? []);
}

/**
 * A bounded TTL cache with in-flight coalescing. Insertion order doubles as
 * the eviction order, which is good enough for a cache whose entries mostly
 * expire on their own.
 */
export class MicroCache {
  private entries = new Map<string, { value: unknown; expiresAt: number }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly maxEntries = 5_000, private readonly now: () => number = Date.now) {}

  get(key: string): unknown | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /**
   * Run `load` once for concurrent callers of the same key. The result is
   * cached for `ttl(result)` ms; a rejection is shared with every waiter and
   * cached by nobody.
   */
  async through<T>(key: string, load: () => Promise<T>, ttl: (result: T) => number): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = (async () => {
      try {
        const v = await load();
        this.set(key, v, ttl(v));
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * How many requests one client may have waiting on the upstream at once.
 *
 * The per-minute limit bounds how much a client sends; it says nothing about
 * how much of the upstream it occupies at any moment. One backfill script at
 * 90 requests/s stayed under 3,000/min per IP for long stretches while holding
 * dozens of upstream connections, and every wallet behind the same gateway
 * saw its p99 go from 1 s to 2 s. A wallet holds one or two requests in
 * flight; a dapp polling hard, perhaps ten. Above the cap a client's requests
 * wait for one of its own to finish — a batch of forty eth_calls is legitimate
 * and simply runs sixteen at a time — and only a client that keeps the cap
 * full for longer than `maxWaitMs` is refused. The upstream stays shared
 * either way: what one address can occupy is bounded.
 */
export class InflightCap {
  private counts = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();

  constructor(
    private readonly max: number,
    private readonly maxWaitMs = 2_000,
  ) {}

  /**
   * Take a slot for `key`, waiting up to maxWaitMs for one; null if none came.
   * Call the returned function when the request is done.
   */
  async acquire(key: string): Promise<(() => void) | null> {
    if (this.max <= 0) return () => {};
    if ((this.counts.get(key) ?? 0) < this.max) {
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      return this.releaser(key);
    }
    // Wait to be handed a slot. The slot is transferred, not freed and
    // re-taken, so the count never exceeds the cap even if a new request
    // arrives between the release and the wake-up.
    const got = await new Promise<boolean>((resolve) => {
      const q = this.waiters.get(key) ?? [];
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(key);
        if (list) {
          const i = list.indexOf(wake);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this.waiters.delete(key);
        }
        resolve(false);
      }, this.maxWaitMs);
      q.push(wake);
      this.waiters.set(key, q);
    });
    return got ? this.releaser(key) : null;
  }

  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const q = this.waiters.get(key);
      const next = q?.shift();
      if (q && !q.length) this.waiters.delete(key);
      if (next) {
        next(); // slot passes to the longest waiter; count unchanged
        return;
      }
      const m = (this.counts.get(key) ?? 1) - 1;
      if (m <= 0) this.counts.delete(key);
      else this.counts.set(key, m);
    };
  }

  inflight(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  waiting(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }
}

/**
 * Whether a hedge may be fired right now.
 *
 * A hedge is a second upstream call for the same read; useful when the
 * primary is occasionally slow, harmful when it is slow because it is
 * saturated, since then every hedge adds to the load that made it slow. The
 * budget is the classic one: over a rolling window, hedges may be at most
 * `ratio` of the reads, with a small floor so quiet periods still hedge. At
 * 17% of 200k reads hedged in one evening — 33k extra upstream calls, of
 * which 1.4k won — the answer should have been "no" long before it was.
 */
export class HedgeBudget {
  private buckets: { at: number; reads: number; hedges: number }[] = [];

  constructor(
    private readonly ratio = 0.1,
    private readonly floorPerWindow = 20,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  private current(): { at: number; reads: number; hedges: number } {
    const t = Math.floor(this.now() / 1000) * 1000;
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.at === t) return last;
    const b = { at: t, reads: 0, hedges: 0 };
    this.buckets.push(b);
    const cutoff = t - this.windowMs;
    while (this.buckets.length && this.buckets[0].at < cutoff) this.buckets.shift();
    return b;
  }

  /** Record one read that could be hedged. */
  read(): void {
    this.current().reads++;
  }

  /** Whether a hedge may fire now; if so it is counted. */
  tryHedge(): boolean {
    this.current();
    let reads = 0;
    let hedges = 0;
    for (const b of this.buckets) {
      reads += b.reads;
      hedges += b.hedges;
    }
    if (hedges >= this.floorPerWindow && hedges + 1 > reads * this.ratio) return false;
    this.current().hedges++;
    return true;
  }
}

/**
 * Race a primary request against a hedge fired after `afterMs`. The first
 * fulfilled answer wins; the hedge is never fired if the primary settles first.
 * Rejections only propagate when every attempt has failed, and then the
 * primary's error is the one reported, since the hedge exists to hide latency,
 * not to change what the caller is told went wrong.
 */
export async function hedged<T>(
  primary: () => Promise<T>,
  hedge: () => Promise<T>,
  afterMs: number,
  onEvent?: (e: "fired" | "won" | "withheld") => void,
  /** Asked at fire time; false means the primary is on its own (see HedgeBudget). */
  mayHedge: () => boolean = () => true,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let primaryError: unknown;
    let hedgeStarted = false;
    let hedgeDone = false;

    const timer = setTimeout(() => {
      if (settled) return;
      if (!mayHedge()) {
        onEvent?.("withheld");
        return;
      }
      hedgeStarted = true;
      onEvent?.("fired");
      hedge().then(
        (v) => {
          hedgeDone = true;
          if (settled) return;
          settled = true;
          onEvent?.("won");
          resolve(v);
        },
        () => {
          hedgeDone = true;
          // The primary already failed and the hedge just did too.
          if (!settled && primaryError !== undefined) {
            settled = true;
            reject(primaryError);
          }
        },
      );
    }, afterMs);

    primary().then(
      (v) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        primaryError = err ?? new Error("upstream failed");
        if (settled) return;
        // Give a running hedge its chance; otherwise this is the answer.
        if (!hedgeStarted || hedgeDone) {
          settled = true;
          reject(primaryError);
        }
      },
    );
  });
}

/**
 * The address the anonymous limits are keyed on.
 *
 * Behind Cloudflare the peer Caddy sees is an edge node, so x-forwarded-for
 * names the edge, not the wallet, and one edge would share a single budget
 * between every wallet it carries. Cloudflare puts the wallet's address in
 * cf-connecting-ip and overwrites any value the client sent. Caddy strips that
 * header from requests that did not arrive from a Cloudflare address
 * (deploy/Caddyfile), so when it reaches us it can be trusted. Without it, the
 * first x-forwarded-for hop is the client when Caddy alone fronts us.
 */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const cf = req.headers["cf-connecting-ip"];
  const cfIp = (Array.isArray(cf) ? cf[0] : cf)?.trim();
  if (cfIp) return cfIp;
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}
