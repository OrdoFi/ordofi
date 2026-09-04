/**
 * Why the bot looks: the sequencer feed, not a timer.
 *
 * A cross-tier dislocation is created by a swap and closed by whoever gets
 * there first. On a chain with 100 ms blocks that is a race measured in
 * milliseconds, and this bot was scanning every thirty seconds — by which time
 * every opportunity it might have taken had been taken by somebody else. It
 * never fired once.
 *
 * The auction already relays the sequencer's feed (apps/auction/src/feedrelay.ts),
 * which is the earliest legitimate view of what just happened. Subscribing to
 * it turns the question from "is anything profitable right now" asked twice a
 * minute into "is *this* pair profitable" asked the moment a swap touches it.
 *
 * Which pair, cheaply: a swap's calldata contains the addresses of the tokens
 * it routes through, whatever router or aggregator built it. Searching the raw
 * bytes for the tokens we track is a string match over a few hundred bytes —
 * no ABI, no simulation, no round trip — and a false positive costs one quote.
 */
import { WebSocket } from "ws";

export interface FeedMessage {
  type: string;
  txs?: { hash: string; raw: string }[];
  receivedAt?: number;
}

/** The tracked tokens whose address appears in this transaction's calldata. */
export function tokensTouched(raw: string, tokens: readonly string[]): string[] {
  const hay = raw.toLowerCase();
  const hits: string[] = [];
  for (const t of tokens) {
    // Addresses appear in calldata without the 0x, either word-aligned or
    // packed inside a V3 path; a plain substring finds both.
    if (hay.includes(t.slice(2).toLowerCase())) hits.push(t);
  }
  return hits;
}

export interface FeedOptions {
  url: string;
  onTxs: (txs: { hash: string; raw: string }[], receivedAt: number) => void;
  /** Reconnect backoff, ms. The feed is the bot's eyes; losing it silently is the failure to avoid. */
  retryMs?: number;
  log?: (line: string) => void;
}

/**
 * Stay connected to the relay, reconnecting for as long as the process lives.
 * Returns a stop function for tests.
 */
export function subscribeFeed(opts: FeedOptions): () => void {
  const retry = opts.retryMs ?? 2_000;
  const log = opts.log ?? ((l: string) => console.log(l));
  let stopped = false;
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const connect = (): void => {
    if (stopped) return;
    ws = new WebSocket(opts.url);

    ws.on("open", () => log(`[arb] feed connected — ${opts.url}`));

    ws.on("message", (data) => {
      let msg: FeedMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== "feed_txs" || !Array.isArray(msg.txs) || msg.txs.length === 0) return;
      opts.onTxs(msg.txs, msg.receivedAt ?? Date.now());
    });

    const again = (why: string) => {
      if (stopped) return;
      log(`[arb] feed ${why}; reconnecting in ${retry}ms`);
      timer = setTimeout(connect, retry);
    };
    ws.on("close", () => again("closed"));
    ws.on("error", (e) => again(`error (${(e as Error).message})`));
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
