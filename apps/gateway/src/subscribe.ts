/**
 * eth_subscribe: the chain pushed to clients instead of asked for.
 *
 * Blocks here are 100 ms apart, and without a subscription the only way to
 * notice one is to ask repeatedly. Clients do exactly that:
 * eth_getBlockByNumber is far and away our busiest method — 604,470 calls in
 * nine hours, eighteen a second, nearly all of it polling for a head that has
 * not moved. Each of those is a request a client had to make, a round trip it
 * had to wait for, and a slot against its rate limit.
 *
 * The shape of the fix is that one poller serves every subscriber. Ten reads a
 * second covers the whole chain for everyone connected, however many that is,
 * and the same read fills the cache the HTTP callers are already served from —
 * so turning this on lowers upstream traffic rather than adding to it. It runs
 * only while somebody is subscribed; with no subscribers it does not run at
 * all.
 *
 * What is here is the part worth testing on its own: which logs match which
 * filter, who is subscribed to what, and the walk from one head to the next.
 * The socket handling is in ws.ts.
 */

import { randomBytes } from "node:crypto";

export type Kind = "newHeads" | "logs";

export interface RawLog {
  address: string;
  topics: string[];
  [k: string]: unknown;
}

/** An eth_getLogs-shaped filter, normalised once so matching is a set lookup. */
export interface LogFilter {
  /** null means every address. */
  address: Set<string> | null;
  /** Per position: null is "anything here", a set is "one of these". */
  topics: (Set<string> | null)[];
}

const lower = (s: unknown): string => String(s).toLowerCase();

/**
 * Read the filter a client passed to eth_subscribe("logs", …).
 *
 * Both `address` and each entry of `topics` may be a single value or a list,
 * and a null entry means the position is unconstrained. Anything we cannot
 * make sense of becomes "unconstrained" rather than an error: a filter that
 * quietly matches too much is a client's own problem, but one that throws
 * turns a working dapp into a broken one on our account.
 */
export function parseLogFilter(param: unknown): LogFilter {
  const p = (param ?? {}) as { address?: unknown; topics?: unknown };
  let address: Set<string> | null = null;
  if (typeof p.address === "string") address = new Set([lower(p.address)]);
  else if (Array.isArray(p.address) && p.address.length) address = new Set(p.address.map(lower));

  const topics: (Set<string> | null)[] = [];
  if (Array.isArray(p.topics)) {
    for (const t of p.topics.slice(0, 4)) {
      if (typeof t === "string") topics.push(new Set([lower(t)]));
      else if (Array.isArray(t) && t.length) topics.push(new Set(t.map(lower)));
      else topics.push(null);
    }
  }
  return { address, topics };
}

/**
 * Ethereum's topic rules: position by position, and a position the filter
 * constrains but the log does not have is a miss.
 */
export function logMatches(log: RawLog, f: LogFilter): boolean {
  if (f.address && !f.address.has(lower(log.address))) return false;
  for (let i = 0; i < f.topics.length; i++) {
    const want = f.topics[i];
    if (!want) continue;
    const got = log.topics?.[i];
    if (!got || !want.has(lower(got))) return false;
  }
  return true;
}

/** Where a subscription's notifications go. One per socket. */
export interface Sink {
  send(payload: string): void;
}

interface Entry {
  sink: Sink;
  kind: Kind;
  filter: LogFilter | null;
}

/**
 * A header as a subscriber should see it.
 *
 * newHeads is the header, not the block: a client that wanted the body would
 * have asked for the block. Sending the transaction list on every head would
 * put a few hundred hashes down every socket ten times a second for something
 * nobody reads.
 */
export function toHeader(block: Record<string, unknown>): Record<string, unknown> {
  const { transactions: _t, uncles: _u, withdrawals: _w, size: _s, ...header } = block;
  return header;
}

/** Who is subscribed to what, and the fan-out to them. */
export class Hub {
  private readonly byId = new Map<string, Entry>();
  private readonly bySink = new Map<Sink, Set<string>>();
  private heads = 0;
  private logs = 0;

  add(sink: Sink, kind: Kind, filter: LogFilter | null): string {
    // Random, not sequential: a subscription id is a handle a client quotes
    // back to us, and one connection should not be able to guess another's.
    const id = `0x${randomBytes(16).toString("hex")}`;
    this.byId.set(id, { sink, kind, filter });
    let own = this.bySink.get(sink);
    if (!own) this.bySink.set(sink, (own = new Set()));
    own.add(id);
    if (kind === "newHeads") this.heads++;
    else this.logs++;
    return id;
  }

  /** Only the connection that made a subscription may cancel it. */
  remove(sink: Sink, id: string): boolean {
    const e = this.byId.get(id);
    if (!e || e.sink !== sink) return false;
    this.byId.delete(id);
    this.bySink.get(sink)?.delete(id);
    if (e.kind === "newHeads") this.heads--;
    else this.logs--;
    return true;
  }

  /** A socket closed: everything it held goes with it. */
  drop(sink: Sink): number {
    const own = this.bySink.get(sink);
    if (!own) return 0;
    for (const id of own) {
      const e = this.byId.get(id);
      if (!e) continue;
      this.byId.delete(id);
      if (e.kind === "newHeads") this.heads--;
      else this.logs--;
    }
    this.bySink.delete(sink);
    return own.size;
  }

  countOf(sink: Sink): number {
    return this.bySink.get(sink)?.size ?? 0;
  }

  get size(): number {
    return this.byId.size;
  }

  /** Whether the watcher needs to run at all, and whether it must fetch logs. */
  get wantsHeads(): boolean {
    return this.heads > 0;
  }
  get wantsLogs(): boolean {
    return this.logs > 0;
  }

  pushHead(header: unknown): void {
    for (const [id, e] of this.byId) {
      if (e.kind !== "newHeads") continue;
      send(e.sink, id, header);
    }
  }

  pushLogs(logs: RawLog[]): void {
    if (!logs.length) return;
    for (const [id, e] of this.byId) {
      if (e.kind !== "logs" || !e.filter) continue;
      for (const log of logs) if (logMatches(log, e.filter)) send(e.sink, id, log);
    }
  }
}

function send(sink: Sink, subscription: string, result: unknown): void {
  try {
    sink.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } }));
  } catch {
    // A socket that has gone away is not an error worth propagating; the close
    // handler will drop its subscriptions in a moment.
  }
}

export interface WatchOptions {
  intervalMs: number;
  /**
   * How far behind the head we will walk block by block. A subscriber expects
   * every block, not the latest one, so a tick that lands late must fill in
   * what it stepped over — but if we fall further behind than this, something
   * is wrong and catching up one block at a time would make it worse.
   */
  maxCatchUp: number;
  onHead(header: Record<string, unknown>): void;
  onLogs(logs: RawLog[]): void;
  wantsLogs(): boolean;
  onError(e: Error): void;
  /** Called with every block we fetch, so the cache HTTP callers read is kept warm. */
  onBlock?(block: Record<string, unknown>): void;
}

type Rpc = (method: string, params: unknown[]) => Promise<any>;

/** Follows the head and hands each new block to the hub. One per process. */
export class HeadWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private last = 0;
  /** Log deliveries, chained so they stay in block order without blocking the head. */
  private logs: Promise<void> = Promise.resolve();

  constructor(
    private readonly rpc: Rpc,
    private readonly opts: WatchOptions,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Unconditionally, whether or not a timer was running: stopping means
    // forgetting where we were, so the next subscriber starts from the head
    // instead of being sent everything that happened while nobody listened.
    this.last = 0;
  }

  /** Exposed for tests; the interval calls this. */
  async tick(): Promise<void> {
    if (this.busy) return; // a slow upstream must not queue ticks behind itself
    this.busy = true;
    try {
      const head = (await this.rpc("eth_getBlockByNumber", ["latest", false])) as Record<string, unknown> | null;
      if (!head?.number) return;
      this.opts.onBlock?.(head);
      const n = Number(head.number);
      if (!Number.isFinite(n) || n <= this.last) return;

      // First tick: this block, and no history.
      const from = this.last === 0 ? n : Math.max(this.last + 1, n - this.opts.maxCatchUp + 1);
      // The blocks stepped over, fetched together rather than in sequence. One
      // after another cost a round trip each, so a tick that had fallen three
      // blocks behind took three times as long, fell further behind while it
      // ran, and never caught up: the chain makes thirteen blocks a second and
      // subscribers were getting five. Concurrently it is one round trip for
      // the whole gap. They are still announced in order.
      const missed: number[] = [];
      for (let b = from; b < n; b++) missed.push(b);
      if (missed.length) {
        const blocks = await Promise.all(
          missed.map((b) => this.rpc("eth_getBlockByNumber", [`0x${b.toString(16)}`, false])),
        );
        for (const block of blocks as (Record<string, unknown> | null)[]) {
          if (!block) continue;
          this.opts.onBlock?.(block);
          this.opts.onHead(toHeader(block));
        }
      }
      this.opts.onHead(toHeader(head));
      this.fetchLogs(from, n);
      this.last = n;
    } catch (e) {
      this.opts.onError(e as Error);
    } finally {
      this.busy = false;
    }
  }

  /**
   * The logs for everything this tick advanced over, in one request and off
   * the critical path.
   *
   * Both of those matter. Asking per block cost a round trip each, and
   * eth_getLogs on this chain takes about 270 ms, so a tick that had advanced
   * three blocks spent the better part of a second before it could poll again
   * — which throttled the head itself to four blocks a second on a chain that
   * makes ten, and only when somebody happened to be watching logs. Awaiting
   * them here would do the same thing with fewer requests. So the heads go out
   * first and the logs follow, chained so they still arrive in block order.
   */
  private fetchLogs(from: number, to: number): void {
    if (!this.opts.wantsLogs()) return;
    const range = [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }];
    const pending = this.rpc("eth_getLogs", range);
    this.logs = this.logs.then(async () => {
      try {
        const logs = (await pending) as RawLog[] | null;
        if (Array.isArray(logs) && logs.length) this.opts.onLogs(logs);
      } catch (e) {
        this.opts.onError(e as Error);
      }
    });
  }

  /** Resolves once the logs for every tick so far have been delivered. For tests. */
  get settled(): Promise<void> {
    return this.logs;
  }
}
