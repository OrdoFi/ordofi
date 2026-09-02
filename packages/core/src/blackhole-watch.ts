/**
 * Watches the addresses nobody controls.
 *
 * Whatever lands on address(1) or its neighbours is gone, and the only way it
 * gets there is a transaction that encoded a recipient wrong — ours or anyone
 * else's on this chain. The delivery proof stops our own calldata from doing
 * that before a wallet sees it; this is the independent check that it worked,
 * and the alarm if anything slips through from any direction. It reads twelve
 * balances a minute and says so, loudly, when one of them grows.
 */
import { rpcFetch } from "./index.ts";
import { BLACKHOLES } from "./guard.ts";

export interface BlackholeAlert {
  address: string;
  before: bigint;
  after: bigint;
  delta: bigint;
  block: number;
  at: string;
}

export interface BlackholeWatchOptions {
  intervalMs?: number;
  /** Called for every increase; defaults to console.error plus the webhook below. */
  onAlert?: (alert: BlackholeAlert) => void | Promise<void>;
  /** POSTs a JSON body; a Slack or Discord incoming webhook works as is. */
  webhookUrl?: string;
  rpc?: (method: string, params: unknown[]) => Promise<unknown>;
  log?: Pick<Console, "error" | "log">;
}

export async function readBlackholes(rpc: BlackholeWatchOptions["rpc"] = rpcFetch): Promise<{ block: number; balances: Map<string, bigint> }> {
  const block = parseInt((await rpc("eth_blockNumber", [])) as string, 16);
  const tag = "0x" + block.toString(16);
  const values = await Promise.all(BLACKHOLES.map((a) => rpc("eth_getBalance", [a, tag])));
  const balances = new Map<string, bigint>();
  BLACKHOLES.forEach((a, i) => balances.set(a, BigInt(values[i] as string)));
  return { block, balances };
}

/** Compare two readings; every address that grew is an alert. */
export function diffBlackholes(prev: Map<string, bigint>, next: { block: number; balances: Map<string, bigint> }): BlackholeAlert[] {
  const out: BlackholeAlert[] = [];
  for (const [address, after] of next.balances) {
    const before = prev.get(address);
    if (before === undefined || after <= before) continue;
    out.push({ address, before, after, delta: after - before, block: next.block, at: new Date().toISOString() });
  }
  return out;
}

export function formatAlert(a: BlackholeAlert): string {
  const eth = (v: bigint) => (Number(v) / 1e18).toFixed(6);
  return `BLACK HOLE FUNDED: ${eth(a.delta)} ETH arrived at ${a.address} by block ${a.block} (now ${eth(a.after)} ETH). Someone's transaction paid an address nobody controls — check our latest deploy and the block's router calls now.`;
}

/**
 * Start polling. Returns a stop function. Never throws: an upstream that is
 * down for a minute is logged and retried, not fatal.
 */
export function startBlackholeWatch(opts: BlackholeWatchOptions = {}): () => void {
  const rpc = opts.rpc ?? rpcFetch;
  const log = opts.log ?? console;
  const webhook = opts.webhookUrl ?? process.env.ORDO_ALERT_WEBHOOK;
  const notify = opts.onAlert ?? (async (a: BlackholeAlert) => {
    log.error(`blackhole | ${formatAlert(a)}`);
    if (!webhook) return;
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatAlert(a), content: formatAlert(a), alert: { ...a, before: a.before.toString(), after: a.after.toString(), delta: a.delta.toString() } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.error(`blackhole | webhook failed: ${(e as Error).message}`);
    }
  });

  let prev: Map<string, bigint> | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const next = await readBlackholes(rpc);
      if (prev) for (const a of diffBlackholes(prev, next)) await notify(a);
      else log.log(`blackhole | watching ${BLACKHOLES.length} addresses from block ${next.block}`);
      prev = next.balances;
    } catch (e) {
      log.error(`blackhole | read failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, opts.intervalMs ?? 60_000);
  (timer as any).unref?.();
  return () => clearInterval(timer);
}
