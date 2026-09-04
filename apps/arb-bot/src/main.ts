import { privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  formatEther,
  parseEther,
  type Hex,
} from "viem";
import { join } from "node:path";
import { normalizePrivateKey, rpcFetch } from "@ordofi/core";
import { ROUTER } from "@ordofi/core/router";
import { QUOTER_V2, buildCycleSwap, poolTiers as tiersFor, quoteCycle as quoteCycleShared, type Cycle } from "@ordofi/core/arb";
import { proveDelivery } from "@ordofi/core/guard";
import { Telemetry, edgeBps, wethReturned } from "./telemetry.js";

/**
 * OrdoFi house arbitrage bot — the profit engine that seeds the loop.
 *
 * It hunts cyclic dislocations: the same pair priced differently across fee
 * tiers, so a round trip WETH -> token -> WETH through two tiers comes back
 * with more WETH than it started. Every candidate is *simulated* against
 * QuoterV2 for free (eth_call, no gas, no state change); a trade is only sent
 * when the simulated return clears gas plus a margin.
 *
 * Safety is structural, not hopeful. Execution is one atomic SwapRouter02
 * multicall: exactInput with amountOutMinimum = principal + margin, then
 * unwrapWETH9 back to native ETH. If the edge evaporated between simulation
 * and inclusion — the usual case on a fast chain — the swap reverts, the whole
 * multicall reverts, and the only cost is gas. Principal is never at risk.
 *
 * It deliberately does NOT touch the auction: this is a plain searcher trading
 * its own capital, kept on its own wallet so its nonces never collide with the
 * house bidding bot. When our own node comes online the lower latency is what
 * turns simulated edges into won ones; until then, expect most edges to be
 * taken by colocated bots first (a revert, a few cents of gas).
 *
 * Env:
 *   ORDO_ARB_KEY          private key of the arb wallet (required to trade)
 *   ORDO_RPC_URLS         upstreams (rpcFetch rotates on throttle/challenge)
 *   ORDO_ARB_MIN_PROFIT_ETH   floor net profit to fire (default 0.000004)
 *   ORDO_ARB_GAS_RESERVE_ETH  ETH kept back for gas, never traded (default 0.0008)
 *   ORDO_ARB_MAX_NOTIONAL_ETH cap per trade (default: whole tradable balance)
 *   ORDO_ARB_DAILY_GAS_CAP_ETH stop firing once gas burned in a rolling day passes this (default 0.01)
 *   ORDO_ARB_INTERVAL_MS      scan cadence (default 12000)
 *   ORDO_ARB_PORT             read-only status endpoint the web app proxies as /api/desk (default 8549)
 *   ORDO_DATA_DIR             where the money ledger (arb-ledger.ndjson) lives
 */

const KEY = normalizePrivateKey(process.env.ORDO_ARB_KEY, "ORDO_ARB_KEY");
if (!KEY) {
  console.error("[arb] ORDO_ARB_KEY is unset — nothing to trade with. Exiting.");
  process.exit(1);
}
const account = privateKeyToAccount(KEY);

const CHAIN_ID = 4663;
const WETH: Hex = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG: Hex = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const SELF = process.env.ORDO_SELF_URL ?? "http://web:3000";
const MIN_PROFIT = parseEther(process.env.ORDO_ARB_MIN_PROFIT_ETH ?? "0.000004");
const GAS_RESERVE = parseEther(process.env.ORDO_ARB_GAS_RESERVE_ETH ?? "0.0008");
const MAX_NOTIONAL = process.env.ORDO_ARB_MAX_NOTIONAL_ETH
  ? parseEther(process.env.ORDO_ARB_MAX_NOTIONAL_ETH)
  : null;
const INTERVAL_MS = Number(process.env.ORDO_ARB_INTERVAL_MS ?? 12000);
// Circuit breaker. Every lost race costs gas and nothing else, but a long run
// of them unattended would still bleed the wallet; past this much gas in a
// rolling day the bot keeps scanning and stops sending.
const DAILY_GAS_CAP = parseEther(process.env.ORDO_ARB_DAILY_GAS_CAP_ETH ?? "0.01");
const gasLedger: { at: number; wei: bigint }[] = [];
function gasBurnedToday(): bigint {
  const cutoff = Date.now() - 86_400_000;
  while (gasLedger.length && gasLedger[0].at < cutoff) gasLedger.shift();
  return gasLedger.reduce((n, e) => n + e.wei, 0n);
}
let breakerLogged = false;
const MAX_CYCLES = Number(process.env.ORDO_ARB_MAX_CYCLES ?? 160);

const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");
const STATUS_PORT = Number(process.env.ORDO_ARB_PORT ?? 8549);
const tele = new Telemetry(join(DATA_DIR, "arb-ledger.ndjson"));
// Past fills seed the breaker, so a restart cannot reset the daily gas budget.
for (const e of tele.replay()) {
  if ((e.kind === "won" || e.kind === "reverted" || e.kind === "lost") && e.t > Date.now() - 86_400_000) gasLedger.push({ at: e.t, wei: BigInt(e.gasWei) });
}
gasLedger.sort((a, b) => a.at - b.at);
const STARTED_AT = Date.now();
let lastBalance: bigint | null = null;
let lastBudget: bigint | null = null;

async function ethCall(to: string, data: Hex): Promise<Hex> {
  return (await rpcFetch("eth_call", [{ to, data }, "latest"])) as Hex;
}

// --- discovery: which cycles even exist -------------------------------------

async function poolTiers(a: Hex, b: Hex): Promise<number[]> {
  return tiersFor(ethCall, a, b);
}

/**
 * Two families of WETH-closed cycles:
 *   cross-tier   WETH -fA-> M -fB-> WETH        (fast, efficient, rarely open)
 *   triangular   WETH -> USDG -> M -> WETH       (thinner pools, more often open)
 * The triangular legs go through USDG because that is where the stock tokens
 * actually have depth; the reverse direction is included since dislocations
 * are one-sided.
 */
async function discoverCycles(): Promise<Cycle[]> {
  const universe = await candidateMids();
  const cycles: Cycle[] = [];
  const wethUsdgTiers = await poolTiers(WETH, USDG);
  const wu = wethUsdgTiers[0]; // deepest-listed WETH/USDG tier for the shared leg

  // A few tokens at a time: discovery used to be one factory call after
  // another and took minutes, which is how long the desk sat at zero cycles.
  await pooled(universe, 4, async ({ address, symbol }) => {
    const wethTiers = await poolTiers(WETH, address);

    for (const fA of wethTiers) {
      for (const fB of wethTiers) {
        if (fA !== fB) cycles.push({ label: `${symbol} ${fA}/${fB}`, tokens: [WETH, address, WETH], fees: [fA, fB] });
      }
    }

    if (address === USDG || wu === undefined || wethTiers.length === 0) return;
    const usdgTiers = await poolTiers(USDG, address);
    for (const fu of usdgTiers) {
      for (const fw of wethTiers) {
        cycles.push({ label: `WETH>USDG>${symbol}>WETH ${wu}/${fu}/${fw}`, tokens: [WETH, USDG, address, WETH], fees: [wu, fu, fw] });
        cycles.push({ label: `WETH>${symbol}>USDG>WETH ${fw}/${fu}/${wu}`, tokens: [WETH, address, USDG, WETH], fees: [fw, fu, wu] });
      }
    }
  });
  return cycles;
}

/** USDG plus the tokens our own endpoint reports actively trading. */
async function candidateMids(): Promise<{ address: Hex; symbol: string }[]> {
  const out = new Map<Hex, string>();
  out.set(USDG, "USDG");
  for (const url of [`${SELF}/api/trade/tokens`, "https://app.ordofi.network/api/trade/tokens"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) continue;
      const list = (await r.json()) as { address?: string; symbol?: string; active?: boolean }[];
      for (const t of list) {
        const a = (t.address ?? "").toLowerCase();
        // Only the actively-traded set: cycles through dead pools waste quotes.
        if (t.active && /^0x[0-9a-f]{40}$/.test(a) && a !== WETH) out.set(a as Hex, (t.symbol ?? "?").slice(0, 10));
      }
      break;
    } catch { /* try the next source */ }
  }
  return [...out].map(([address, symbol]) => ({ address, symbol }));
}

// --- simulation --------------------------------------------------------------

async function quoteCycle(c: Cycle, amountIn: bigint): Promise<bigint | null> {
  return quoteCycleShared(ethCall, c, amountIn);
}

// --- chain state -------------------------------------------------------------

let maxFeePerGas = 2_000_000_000n;
async function refreshGas(): Promise<void> {
  try {
    maxFeePerGas = BigInt((await rpcFetch("eth_gasPrice", [])) as string) * 2n;
  } catch { /* keep the last value */ }
}

async function tradableBalance(): Promise<bigint> {
  const bal = BigInt((await rpcFetch("eth_getBalance", [account.address, "latest"])) as string);
  const free = bal > GAS_RESERVE ? bal - GAS_RESERVE : 0n;
  const budget = MAX_NOTIONAL && free > MAX_NOTIONAL ? MAX_NOTIONAL : free;
  lastBalance = bal;
  lastBudget = budget;
  return budget;
}

/** Two sizes — a third and the whole budget; price impact makes the best interior. */
function sizeLadder(budget: bigint): bigint[] {
  const third = budget / 3n;
  const sizes = [third, budget].filter((s) => s > 0n);
  return [...new Set(sizes.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
}

// --- execution ---------------------------------------------------------------

/** WETH -> ... -> WETH round trip, paid back to this wallet as native ETH. */
function buildTx(c: Cycle, amountIn: bigint, minReturn: bigint): Hex {
  return buildCycleSwap(c, amountIn, minReturn);
}

let busy = false; // one scan/fire at a time — quotes are many and the RPC is shared

/**
 * Set the moment a fill fails to bring the principal back to this wallet.
 * From then on the bot scans but never fires again until a human restarts it:
 * a round trip that "succeeds" while the ETH goes elsewhere is the one failure
 * that gets worse with every repetition.
 */
let halted: string | null = null;

/** Run tasks with bounded concurrency so a scan is fast but never floods the upstream. */
async function pooled<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

async function tick(cycles: Cycle[]): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await scan(cycles);
  } catch (e) {
    console.warn(`[arb] scan: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

async function scan(cycles: Cycle[]): Promise<void> {
  const budget = await tradableBalance();
  if (budget < parseEther("0.0002")) {
    console.log(`[arb] idle — tradable ${formatEther(budget)} ETH is below the dust floor; fund ${account.address}`);
    tele.note("idle", `tradable ${formatEther(budget)} ETH is below the dust floor`);
    return;
  }

  const sizes = sizeLadder(budget);
  const tasks = cycles.flatMap((c) => sizes.map((amountIn) => ({ c, amountIn })));
  const found: { c: Cycle; amountIn: bigint; out: bigint; gross: bigint }[] = [];
  // The closest edge, profitable or not: the honest picture of how far the
  // market is from paying us, sampled every scan for the public desk page.
  const closest = { bps: -Infinity, label: null as string | null };
  await pooled(tasks, 8, async ({ c, amountIn }) => {
    const out = await quoteCycle(c, amountIn);
    if (out == null) return;
    const bps = edgeBps(amountIn, out);
    if (bps > closest.bps) { closest.bps = bps; closest.label = c.label; }
    if (out > amountIn) found.push({ c, amountIn, out, gross: out - amountIn });
  });
  tele.scan({ t: Date.now(), quotes: tasks.length, bestBps: closest.label ? closest.bps : null, bestLabel: closest.label, positive: found.length });

  if (found.length === 0) {
    console.log(`[arb] scanned ${tasks.length} quotes · no positive round trip · budget ${formatEther(budget)} ETH`);
    return;
  }
  const best = found.reduce((a, b) => (b.gross > a.gross ? b : a));
  if (halted) {
    console.error(`[arb] HALTED — not firing on ${best.c.label}: ${halted}`);
    return;
  }

  // Price the real transaction. eth_estimateGas double-checks it would not
  // revert *and* gives the gas to subtract from the edge; a revert here means
  // the opportunity is already gone.
  const minReturn = best.amountIn + MIN_PROFIT;
  const data = buildTx(best.c, best.amountIn, minReturn);
  const value = "0x" + best.amountIn.toString(16);
  let gas: bigint;
  try {
    const g = (await rpcFetch("eth_estimateGas", [{ from: account.address, to: ROUTER, data, value }])) as string;
    gas = (BigInt(g) * 5n) / 4n; // 25% headroom over the estimate
  } catch {
    // would revert — edge taken, or too thin for the min-return guard
    tele.note("gone", `edge on ${best.c.label} (+${formatEther(best.gross)} ETH gross) vanished before we could price it`, best.c.label);
    return;
  }

  // Not reverting is not the same as being paid. Execute the round trip from
  // this wallet and require the ETH to come back here — principal plus the
  // profit floor — with nothing left in the router or lost to a black hole.
  const proof = await proveDelivery({
    from: account.address,
    tx: { to: ROUTER as Hex, data, value: best.amountIn },
    expect: [{ asset: "eth", min: MIN_PROFIT }],
    mustNotRetain: [{ holder: ROUTER as Hex, asset: "eth" }, { holder: ROUTER as Hex, asset: WETH as Hex }],
  });
  if (!proof.ok) {
    if (proof.unavailable || proof.reverted) {
      tele.note("gone", `could not prove the round trip on ${best.c.label}: ${proof.reason}`, best.c.label);
      return;
    }
    // The transaction would succeed and the money would not come back to us.
    halted = `delivery proof failed on ${best.c.label}: ${proof.reason}`;
    console.error(`[arb] REFUSED and HALTED — ${halted}`);
    tele.note("halt", halted, best.c.label);
    return;
  }
  const gasCost = gas * maxFeePerGas;
  const net = best.gross - gasCost;
  if (net < MIN_PROFIT) {
    console.log(`[arb] pass ${best.c.label}: gross ${formatEther(best.gross)} ETH < gas ${formatEther(gasCost)} + floor`);
    tele.note("pass", `gross +${formatEther(best.gross)} ETH does not clear gas ${formatEther(gasCost)} ETH + floor`, best.c.label);
    return;
  }

  const burned = gasBurnedToday();
  if (burned >= DAILY_GAS_CAP) {
    if (!breakerLogged) {
      console.warn(`[arb] circuit breaker: ${formatEther(burned)} ETH of gas burned in 24h ≥ cap ${formatEther(DAILY_GAS_CAP)} — scanning only until it rolls off`);
      tele.note("breaker", `daily gas cap reached (${formatEther(burned)} ETH) — scanning only until it rolls off`);
    }
    breakerLogged = true;
    return;
  }
  breakerLogged = false;

  const nonce = parseInt((await rpcFetch("eth_getTransactionCount", [account.address, "pending"])) as string, 16);
  const raw = await account.signTransaction({
    chainId: CHAIN_ID, to: ROUTER as Hex, data: data as Hex, value: best.amountIn,
    gas, maxFeePerGas, maxPriorityFeePerGas: 0n, nonce, type: "eip1559",
  });
  const hash = (await rpcFetch("eth_sendRawTransaction", [raw])) as string;
  console.log(`[arb] FIRING ${best.c.label} size ${formatEther(best.amountIn)} ETH · sim net ${formatEther(net)} ETH · ${hash}`);
  tele.record({ kind: "fire", t: Date.now(), cycle: best.c.label, sizeWei: best.amountIn.toString(), simNetWei: net.toString(), hash });
  await confirm(hash, best.c.label, best.amountIn, minReturn);
}

async function confirm(hash: string, cycle: string, amountIn: bigint, minReturn: bigint): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const rec = (await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null)) as
      | { status: string; gasUsed: string; effectiveGasPrice?: string; logs?: { address: string; topics: string[]; data: string }[] }
      | null;
    if (!rec) continue;
    const gasUsed = BigInt(rec.gasUsed);
    const gasPrice = BigInt(rec.effectiveGasPrice ?? maxFeePerGas);
    const gasWei = gasUsed * gasPrice;
    gasLedger.push({ at: Date.now(), wei: gasWei });
    if (rec.status === "0x1") {
      // Exact proceeds from the WETH Withdrawal event; the min-return guard is
      // a floor if the log is ever missing, never an overstatement.
      const returned = wethReturned(rec.logs, WETH, ROUTER);
      // The Withdrawal event says the router unwrapped the WETH; only the
      // wallet's balance says who received it. Anything short of principal
      // minus gas means the ETH went somewhere else, and the bot stops.
      const before = lastBalance;
      const after = BigInt((await rpcFetch("eth_getBalance", [account.address, "latest"]).catch(() => "0x0")) as string);
      if (before != null && after > 0n && after < before - gasWei) {
        const missing = before - gasWei - after;
        halted = `fill ${hash} returned ${formatEther(returned ?? 0n)} ETH per the router but the wallet is short ${formatEther(missing)} ETH`;
        console.error(`[arb] PROCEEDS MISSING — HALTED: ${halted}`);
        tele.note("halt", halted, cycle);
        tele.record({ kind: "lost", t: Date.now(), cycle, sizeWei: amountIn.toString(), missingWei: missing.toString(), gasWei: gasWei.toString(), hash });
        return;
      }
      console.log(`[arb] WON ${hash} — round trip cleared, +${formatEther((returned ?? minReturn) - amountIn)} ETH gross (gas ${formatEther(gasWei)} ETH)`);
      tele.record({ kind: "won", t: Date.now(), cycle, sizeWei: amountIn.toString(), returnedWei: (returned ?? minReturn).toString(), estimated: returned == null, gasWei: gasWei.toString(), hash });
    } else {
      console.log(`[arb] reverted ${hash} — edge taken first, cost gas ${formatEther(gasWei)} ETH (principal safe)`);
      tele.record({ kind: "reverted", t: Date.now(), cycle, sizeWei: amountIn.toString(), gasWei: gasWei.toString(), hash });
    }
    return;
  }
  console.warn(`[arb] ${hash} unconfirmed in 30s`);
  tele.note("info", `${hash} unconfirmed after 30s`, cycle);
}

// --- main --------------------------------------------------------------------

console.log(`OrdoFi arb bot | ${account.address}`);
let cycles: Cycle[] = [];

// Status first, discovery second: the desk page should say "live, discovering"
// during the minute or two of factory lookups, not "offline".
tele.serve(STATUS_PORT, {
  address: account.address,
  chainId: CHAIN_ID,
  startedAt: STARTED_AT,
  config: {
    minProfitEth: formatEther(MIN_PROFIT),
    gasReserveEth: formatEther(GAS_RESERVE),
    maxNotionalEth: MAX_NOTIONAL ? formatEther(MAX_NOTIONAL) : null,
    dailyGasCapEth: formatEther(DAILY_GAS_CAP),
    intervalMs: INTERVAL_MS,
    maxCycles: MAX_CYCLES,
    router: ROUTER,
    quoter: QUOTER_V2,
  },
  universe: () => ({
    cycles: cycles.length,
    routes: new Set(cycles.map((c) => c.tokens.join(">"))).size,
    crossTier: cycles.filter((c) => c.fees.length === 2).length,
    triangular: cycles.filter((c) => c.fees.length === 3).length,
    labels: cycles.map((c) => c.label),
  }),
  chain: () => ({ balanceWei: lastBalance, budgetWei: lastBudget, maxFeePerGas }),
  gas24h: gasBurnedToday,
  dailyGasCap: DAILY_GAS_CAP,
  breaker: () => gasBurnedToday() >= DAILY_GAS_CAP,
});

// Cross-tier cycles (shorter paths) sort first, so the cap keeps the cheapest,
// most-liquid routes when the discovered set is larger than the budget allows.
const rankCycles = (cs: Cycle[]) => cs.sort((a, b) => a.fees.length - b.fees.length).slice(0, MAX_CYCLES);
cycles = rankCycles(await discoverCycles());
const midCount = new Set(cycles.map((c) => c.tokens.join(">"))).size;
console.log(`OrdoFi arb bot | ${cycles.length} cycles (cross-tier + triangular) across ${midCount} routes`);
console.log(`OrdoFi arb bot | min net ${formatEther(MIN_PROFIT)} ETH · gas reserve ${formatEther(GAS_RESERVE)} ETH · per-trade cap ${MAX_NOTIONAL ? formatEther(MAX_NOTIONAL) + " ETH" : "none"} · daily gas cap ${formatEther(DAILY_GAS_CAP)} ETH · scan ${INTERVAL_MS}ms`);

await refreshGas();
setInterval(() => { refreshGas().catch(() => {}); }, 20_000);
// Pools come and go; re-discover occasionally without blocking the scan loop.
setInterval(() => { discoverCycles().then((c) => { if (c.length) cycles = rankCycles(c); }).catch(() => {}); }, 600_000);

if (cycles.length === 0) {
  console.warn("[arb] no cross-tier cycles found — the arb surface is empty right now; will re-scan every 10 min");
}
setInterval(() => { tick(cycles).catch((e) => console.warn(`[arb] tick: ${(e as Error).message}`)); }, INTERVAL_MS);
