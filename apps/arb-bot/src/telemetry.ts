import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { formatEther, toEventSelector } from "viem";

/**
 * What the arb bot shows the outside world.
 *
 * Two kinds of record. Ledger events (fire / won / reverted) are money moving
 * and are appended to an NDJSON file so totals survive restarts and anyone can
 * audit them against the chain. Notes (pass / gone / breaker / idle) and scan
 * samples are the bot thinking out loud; they live in memory only, because a
 * scan every twelve seconds forever is noise, not history.
 */

export type LedgerEvent =
  | { kind: "fire"; t: number; cycle: string; sizeWei: string; simNetWei: string; hash: string }
  | { kind: "won"; t: number; cycle: string; sizeWei: string; returnedWei: string; estimated: boolean; gasWei: string; hash: string }
  | { kind: "reverted"; t: number; cycle: string; sizeWei: string; gasWei: string; hash: string }
  /** The transaction succeeded but the wallet ended up short: money left and did not come back. */
  | { kind: "lost"; t: number; cycle: string; sizeWei: string; missingWei: string; gasWei: string; hash: string };

export interface Note { kind: "pass" | "gone" | "breaker" | "idle" | "info" | "halt"; t: number; text: string; cycle?: string }

export interface ScanSample { t: number; quotes: number; bestBps: number | null; bestLabel: string | null; positive: number }

export interface Totals { fires: number; won: number; reverted: number; lost: number; gasWei: bigint; grossWei: bigint }

/** Round-trip edge in basis points, signed; 2 decimals is plenty for display. */
export function edgeBps(amountIn: bigint, amountOut: bigint): number {
  if (amountIn === 0n) return 0;
  return Number(((amountOut - amountIn) * 1_000_000n) / amountIn) / 100;
}

const WITHDRAWAL = toEventSelector("Withdrawal(address,uint256)");

/**
 * How much ETH the router actually handed back. SwapRouter02's unwrapWETH9
 * withdraws its whole WETH balance in one call, so the WETH9 Withdrawal event
 * with the router as `src` is the exact round-trip proceeds.
 */
export function wethReturned(
  logs: { address: string; topics: string[]; data: string }[] | undefined,
  weth: string,
  router: string,
): bigint | null {
  if (!logs) return null;
  const want = router.toLowerCase().slice(2).padStart(64, "0");
  for (const l of logs) {
    if (l.address.toLowerCase() !== weth.toLowerCase()) continue;
    if (l.topics[0]?.toLowerCase() !== WITHDRAWAL) continue;
    if ((l.topics[1] ?? "").toLowerCase().slice(2) !== want) continue;
    return BigInt(l.data);
  }
  return null;
}

export function replayTotals(events: LedgerEvent[]): Totals {
  const t: Totals = { fires: 0, won: 0, reverted: 0, lost: 0, gasWei: 0n, grossWei: 0n };
  for (const e of events) {
    if (e.kind === "fire") t.fires++;
    else if (e.kind === "won") {
      t.won++;
      t.gasWei += BigInt(e.gasWei);
      t.grossWei += BigInt(e.returnedWei) - BigInt(e.sizeWei);
    } else if (e.kind === "reverted") {
      t.reverted++;
      t.gasWei += BigInt(e.gasWei);
    } else if (e.kind === "lost") {
      t.lost++;
      t.gasWei += BigInt(e.gasWei);
      t.grossWei -= BigInt(e.missingWei);
    }
  }
  return t;
}

export function parseLedger(text: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEvent;
      if (e && typeof e.kind === "string" && typeof e.t === "number") out.push(e);
    } catch { /* a torn last line from a crash mid-write; skip it */ }
  }
  return out;
}

export interface StatusContext {
  address: string;
  chainId: number;
  startedAt: number;
  config: Record<string, string | number | null>;
  universe: () => { cycles: number; routes: number; crossTier: number; triangular: number; labels: string[] };
  chain: () => { balanceWei: bigint | null; budgetWei: bigint | null; maxFeePerGas: bigint };
  gas24h: () => bigint;
  dailyGasCap: bigint;
  breaker: () => boolean;
}

const MAX_SAMPLES = 240;
const MAX_EVENTS = 80;

export class Telemetry {
  private events: LedgerEvent[] = [];
  private notes: Note[] = [];
  private samples: ScanSample[] = [];
  private totals: Totals = { fires: 0, won: 0, reverted: 0, lost: 0, gasWei: 0n, grossWei: 0n };
  private scanCount = 0;
  private quotesTotal = 0;

  constructor(private readonly ledgerPath: string) {}

  /** Load past money events; returns them so the caller can seed its own state (e.g. the gas breaker). */
  replay(): LedgerEvent[] {
    if (!existsSync(this.ledgerPath)) return [];
    const all = parseLedger(readFileSync(this.ledgerPath, "utf8"));
    this.totals = replayTotals(all);
    this.events = all.slice(-MAX_EVENTS);
    return all;
  }

  record(e: LedgerEvent): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    appendFileSync(this.ledgerPath, JSON.stringify(e) + "\n");
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.totals = this.merge(e);
  }

  private merge(e: LedgerEvent): Totals {
    const d = replayTotals([e]);
    return {
      fires: this.totals.fires + d.fires,
      won: this.totals.won + d.won,
      reverted: this.totals.reverted + d.reverted,
      lost: this.totals.lost + d.lost,
      gasWei: this.totals.gasWei + d.gasWei,
      grossWei: this.totals.grossWei + d.grossWei,
    };
  }

  note(kind: Note["kind"], text: string, cycle?: string): void {
    this.notes.push({ kind, t: Date.now(), text, cycle });
    if (this.notes.length > MAX_EVENTS) this.notes.shift();
  }

  scan(s: ScanSample): void {
    this.scanCount++;
    this.quotesTotal += s.quotes;
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  snapshot(ctx: StatusContext) {
    const chain = ctx.chain();
    const gas24h = ctx.gas24h();
    const feed = [
      ...this.events.map((e) => ({ ...e })),
      ...this.notes.map((n) => ({ ...n })),
    ].sort((a, b) => b.t - a.t).slice(0, MAX_EVENTS);
    const last = this.samples[this.samples.length - 1] ?? null;
    return {
      ok: true,
      live: true,
      now: Date.now(),
      address: ctx.address,
      chainId: ctx.chainId,
      startedAt: ctx.startedAt,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
      balanceEth: chain.balanceWei == null ? null : formatEther(chain.balanceWei),
      budgetEth: chain.budgetWei == null ? null : formatEther(chain.budgetWei),
      gasPriceGwei: Number(chain.maxFeePerGas / 2n) / 1e9,
      config: ctx.config,
      universe: ctx.universe(),
      scans: {
        count: this.scanCount,
        quotesTotal: this.quotesTotal,
        lastAt: last?.t ?? null,
        last,
        history: this.samples,
      },
      totals: {
        fires: this.totals.fires,
        won: this.totals.won,
        reverted: this.totals.reverted,
        gasEth: formatEther(this.totals.gasWei),
        grossEth: formatEther(this.totals.grossWei),
        netEth: formatEther(this.totals.grossWei - this.totals.gasWei),
        gas24hEth: formatEther(gas24h),
        dailyGasCapEth: formatEther(ctx.dailyGasCap),
        breaker: ctx.breaker(),
      },
      events: feed,
    };
  }

  /** Tiny read-only HTTP surface: the web app proxies /status to the public. */
  serve(port: number, ctx: StatusContext): void {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/status" || path === "/") {
        const body = JSON.stringify(this.snapshot(ctx));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (path === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.on("error", (e) => console.warn(`[arb] status server: ${(e as Error).message}`));
    server.listen(port, () => console.log(`OrdoFi arb bot | status on :${port}/status`));
  }
}
