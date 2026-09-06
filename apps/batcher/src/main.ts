/**
 * Ordo Batch — the batcher.
 *
 * Orders arrive as signed intents (or as ether deposits) and wait up to one
 * window. Every window, each pair's orders are solved together: whatever nets
 * peer-to-peer never touches the pool, the residual is quoted against the real
 * AMM through `OrdoBatch.simulate`, the clearing price is set from that
 * answer, the settlement is dry-run, and then sent on the private path.
 *
 *   POST /order            { order, signature }  → { orderHash, status }
 *   GET  /order/:hash      → status
 *   GET  /health /stats /batches
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { rpcFetch } from "@ordofi/core";
import { OrdoStore } from "@ordofi/store";
import { candidateRoutes, type Route, type V4Source } from "../../gateway/src/ordoswap2.js";
import { Chain } from "./chain.js";
import { batchHtml } from "./page.js";
import {
  ZERO,
  acceptable,
  asToken,
  buyAmount,
  compositions,
  discoveryClearing,
  groupByPair,
  interactionsFor,
  limitFailures,
  low,
  nettedA,
  nextClearing,
  prices,
  residual,
  spread,
  sum,
  without,
  type Allocation,
  type Clearing,
  type PairBatch,
} from "./solver.js";
import type { BatchRecord, Interaction, Leg, Order, OrderStatus, Pending, SimResult } from "./types.js";

// ------------------------------------------------------------------ config

const PORT = Number(process.env.ORDO_BATCHER_PORT ?? 8550);
const CHAIN_ID = Number(process.env.ORDO_CHAIN_ID ?? 4663);
const BATCH = low(process.env.ORDO_BATCH_ADDRESS ?? "");
const SOLVER_KEY = (process.env.ORDO_BATCH_SOLVER_KEY ?? "") as Hex;
const WINDOW_MS = Number(process.env.ORDO_BATCH_WINDOW_MS ?? 300);
const FEE_BPS = BigInt(process.env.ORDO_BATCH_FEE_BPS ?? 10);
const MAX_VALID_S = Number(process.env.ORDO_BATCH_MAX_VALID_S ?? 600);
const MAX_ATTEMPTS = 3;
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");

// Not configured yet (contract not deployed, or no solver key): stay up and
// say so on /health rather than crash-loop in compose. Nothing is accepted.
const CONFIGURED = /^0x[0-9a-f]{40}$/.test(BATCH) && /^0x[0-9a-fA-F]{64}$/.test(SOLVER_KEY);
if (!CONFIGURED) {
  console.warn("batcher | not configured: set ORDO_BATCH_ADDRESS (the OrdoBatch contract) and ORDO_BATCH_SOLVER_KEY (the solver's hot key). Idle.");
  createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "unconfigured", need: ["ORDO_BATCH_ADDRESS", "ORDO_BATCH_SOLVER_KEY"] }));
  }).listen(PORT, () => console.log(`Ordo Batch | idle on :${PORT}`));
  // The rest of this module is the configured service.
  await new Promise(() => {});
}

const chain = new Chain({ chainId: CHAIN_ID, batch: BATCH, solverKey: SOLVER_KEY });

// V4 pools by pair come from the shared index; without it only V3 routes exist.
let v4: V4Source | null = null;
try {
  const store = new OrdoStore(process.env.ORDO_DB ?? join(DATA_DIR, "ordo.db"));
  v4 = { v4PoolsForPair: (a, b) => store.v4PoolsForPair(a, b) };
} catch (e) {
  console.warn(`batcher | index unavailable, V3 routes only (${(e as Error).message})`);
}

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const ledgerFile = join(DATA_DIR, "batches.ndjson");

/** The last settlements from disk, so a restart does not blank the page. */
function loadLedger(): BatchRecord[] {
  try {
    if (!existsSync(ledgerFile)) return [];
    const lines = readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean).slice(-200);
    return lines
      .map((l) => {
        try {
          const r = JSON.parse(l);
          for (const k of ["nettedA", "residualA", "residualB", "fee", "gasUsed"]) if (r[k] != null) r[k] = BigInt(r[k]);
          return r as BatchRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is BatchRecord => !!r)
      .reverse();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------- state

const orders = new Map<Hex, Pending>();
const inFlight = new Set<Hex>();
/** After a refused send, no settlement is attempted before this time. */
let sendPausedUntil = 0;
const recentBatches: BatchRecord[] = loadLedger();
const stats = {
  received: 0,
  rejected: 0,
  filled: 0,
  expired: 0,
  batches: 0,
  batchesFailed: 0,
  /** Orders that met a counterparty rather than the pool. */
  netted: 0,
  windows: 0,
};
let maxFeeBps = 30n;

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

// ------------------------------------------------------------------ intake

function parseOrder(raw: Record<string, unknown>): Order {
  const addr = (k: string, optional = false): Hex => {
    const v = raw[k];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
      if (optional && (v === undefined || v === null || v === "")) return ZERO;
      throw new Error(`order.${k} must be an address`);
    }
    return low(v);
  };
  const big = (k: string): bigint => {
    const v = raw[k];
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`order.${k} must be a numeric string`);
    try {
      return BigInt(v);
    } catch {
      throw new Error(`order.${k} is not an integer`);
    }
  };
  const appData = typeof raw.appData === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw.appData) ? (raw.appData.toLowerCase() as Hex) : (`0x${"0".repeat(64)}` as Hex);
  return {
    owner: addr("owner"),
    receiver: addr("receiver", true),
    sellToken: addr("sellToken"),
    buyToken: addr("buyToken", true),
    sellAmount: big("sellAmount"),
    minBuyAmount: big("minBuyAmount"),
    validTo: Number(big("validTo")),
    nonce: big("nonce"),
    appData,
  };
}

async function intake(body: { order?: Record<string, unknown>; signature?: string }): Promise<{ orderHash: Hex; status: OrderStatus }> {
  if (!body?.order) throw new Error("order required");
  const o = parseOrder(body.order);
  const now = Math.floor(Date.now() / 1000);
  if (o.sellAmount <= 0n) throw new Error("sellAmount must be positive");
  if (asToken(o.sellToken) === asToken(o.buyToken)) throw new Error("sellToken and buyToken are the same");
  if (o.sellToken === ZERO) throw new Error("to pay in ether, call depositOrder with sellToken = WETH and post the order with no signature");
  if (o.validTo <= now + 1) throw new Error("validTo is in the past");
  if (o.validTo > now + MAX_VALID_S) throw new Error(`validTo may be at most ${MAX_VALID_S}s ahead`);

  const hash = chain.orderHash(o);
  const existing = orders.get(hash);
  if (existing) return { orderHash: hash, status: existing.status };

  const sigRaw = body.signature ?? "";
  const deposited = sigRaw === "" || sigRaw === "0x";
  const signature = (deposited ? "0x" : sigRaw) as Hex;
  if (await chain.nonceUsed(o.owner, o.nonce)) throw new Error("nonce already used or cancelled");

  let status: OrderStatus = { state: "pending" };
  if (deposited) {
    const esc = await chain.escrowed(hash);
    if (esc === 0n) status = { state: "awaiting_deposit" };
    else if (esc !== o.sellAmount) throw new Error("escrowed amount does not match sellAmount");
  } else {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("signature must be 65 bytes");
    // ECDSA first; a smart wallet (code, and not just a 7702 delegation) is
    // checked by the contract through ERC-1271 at settlement.
    const who = await chain.signer(o, signature);
    if (who !== o.owner && !(await chain.hasCode(o.owner))) throw new Error("signature does not match owner");
    const pull = await chain.canPull(o.owner, o.sellToken, o.sellAmount);
    if (!pull.ok) throw new Error(pull.why!);
  }

  orders.set(hash, { order: o, signature: deposited ? "0x" : signature, hash, deposited, receivedAt: Date.now(), attempts: 0, status });
  stats.received++;
  return { orderHash: hash, status };
}

// ------------------------------------------------------------------ solving

interface Solved {
  batch: PairBatch;
  clearing: Clearing;
  interactions: Interaction[];
  sim: SimResult;
  dropped: { order: Order; reason: string }[];
  /** What each side would get sending everything to the AMM alone. */
  aloneB: bigint;
  aloneA: bigint;
}

const routeCache = new Map<string, { at: number; routes: Route[] }>();
async function routesFor(a: Hex, b: Hex): Promise<Route[]> {
  const k = `${a}>${b}`;
  const hit = routeCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.routes;
  const routes = await candidateRoutes(rpcFetch, v4, a, b);
  routeCache.set(k, { at: Date.now(), routes });
  return routes;
}

const allOrders = (b: PairBatch): Order[] => [...b.sellA, ...b.sellB];

/**
 * How to send one whole side to the AMM: the split across the top routes that
 * returns the most. Every candidate split is one `simulate`, all fired
 * together; a first pass on quarters, a second on eighths around the winner.
 * A single route is just the split that puts everything on it.
 */
async function bestRoute(batch: PairBatch, routes: Route[], sideA: boolean): Promise<{ alloc: Allocation; out: bigint; singleOut: bigint } | null> {
  const amount = sum((sideA ? batch.sellA : batch.sellB).map((o) => o.sellAmount));
  if (amount === 0n || routes.length === 0) return null;
  const dummy = prices(batch, { pA: 1n, pB: 1n });
  const want = sideA ? batch.b : batch.a;
  const top = routes.slice(0, 3).map((r) => r.legs as Leg[]);

  const outOf = async (alloc: Allocation): Promise<bigint> => {
    const xs = spread(amount, alloc);
    if (xs.length === 0) return 0n;
    const sim = await chain.simulate(allOrders(batch), dummy, xs);
    if ("error" in sim) return 0n;
    const i = sim.tokens.findIndex((t) => t === want);
    return i < 0 ? 0n : sim.delta[i];
  };
  const evaluate = async (den: bigint, grid: bigint[][]): Promise<{ alloc: Allocation; out: bigint } | null> => {
    const cands = grid.map((nums) => ({ parts: top.map((legs, i) => ({ legs, num: nums[i] ?? 0n })), den }));
    const outs = await Promise.all(cands.map(outOf));
    let best: { alloc: Allocation; out: bigint } | null = null;
    outs.forEach((out, i) => {
      if (out > 0n && (!best || out > best.out)) best = { alloc: cands[i], out };
    });
    return best;
  };

  // Pass 1: quarters. With three routes that is 15 simulations; with one, 1.
  const grid = compositions(top.length, 4n);
  const first = await evaluate(4n, grid);
  if (!first) return null;
  // What a plain swap would get: the best single route. The page shows the
  // fill against this, so a split that helped shows up as the gain it is.
  let singleOut = 0n;
  for (const nums of grid) {
    if (nums.filter((n) => n > 0n).length !== 1) continue;
    const out = await outOf({ parts: top.map((legs, i) => ({ legs, num: nums[i] })), den: 4n });
    if (out > singleOut) singleOut = out;
  }
  if (top.length === 1) return { ...first, singleOut };
  // Pass 2: eighths, only the neighbours of the winner (each part ±1/8).
  const centre = first.alloc.parts.map((p) => p.num * 2n);
  const seen = new Set<string>();
  const near: bigint[][] = [];
  for (const nums of compositions(top.length, 8n)) {
    if (nums.every((n, i) => (n > centre[i] ? n - centre[i] : centre[i] - n) <= 1n)) {
      const k = nums.join(",");
      if (!seen.has(k)) {
        seen.add(k);
        near.push(nums);
      }
    }
  }
  const second = await evaluate(8n, near);
  return { ...(second && second.out > first.out ? second : first), singleOut };
}

async function solve(initial: PairBatch): Promise<Solved | { error: string; dropped: { order: Order; reason: string }[] }> {
  let batch = initial;
  const dropped: { order: Order; reason: string }[] = [];
  const [routesAB, routesBA] = await Promise.all([routesFor(batch.a, batch.b), routesFor(batch.b, batch.a)]);
  const [ab, ba] = await Promise.all([bestRoute(batch, routesAB, true), bestRoute(batch, routesBA, false)]);

  let c = discoveryClearing(batch, ab?.out ?? 0n, ba?.out ?? 0n);
  if (!c) return { error: "no route returns anything for this pair", dropped };

  let sim: SimResult | null = null;
  let interactions: Interaction[] = [];
  for (let round = 0; round < 6; round++) {
    const fails = limitFailures(batch, c);
    if (fails.length) {
      for (const o of fails) dropped.push({ order: o, reason: `limit not met at the clearing price (${buyAmount(o, batch, c)} < ${o.minBuyAmount})` });
      batch = without(batch, fails);
      if (allOrders(batch).length === 0) return { error: "no order's limit can be met", dropped };
      // The sides changed; the AMM guess for what is left is still the same rate.
    }
    const res = residual(batch, c);
    interactions = interactionsFor(res, ab?.alloc ?? null, ba?.alloc ?? null);
    if ((res.a > 0n && !ab) || (res.b > 0n && !ba)) return { error: "residual has no route", dropped };
    const s = await chain.simulate(allOrders(batch), prices(batch, c), interactions);
    if ("error" in s) return { error: `simulate: ${s.error}`, dropped };
    sim = s;
    // The fee is a share of the improvement, not of the fill. A one-sided
    // batch is the pool's own price by another road; charging on it made
    // Batch strictly worse than Instant whenever nobody was on the other side,
    // which is most windows until there is flow. So: no counterparty, no fee —
    // the user gets exactly what the pool gives, and we pay the gas.
    const oneSided = batch.sellA.length === 0 || batch.sellB.length === 0;
    const next = nextClearing(batch, c, s, oneSided ? 0n : FEE_BPS, res);
    const moved = next.pA !== c.pA || next.pB !== c.pB;
    const ok = acceptable(batch, s, maxFeeBps).ok;
    // Converged: accepted, and the price would move by less than a basis point.
    const rel = (x: bigint, y: bigint) => (x === y ? 0n : (x > y ? x - y : y - x) * 100_000n / (y || 1n));
    if (ok && rel(next.pA, c.pA) < 10n && rel(next.pB, c.pB) < 10n) break;
    c = next;
    if (!moved && !ok) return { error: `unacceptable: ${acceptable(batch, s, maxFeeBps).why}`, dropped };
  }
  if (!sim) return { error: "no simulation", dropped };
  const finalCheck = acceptable(batch, sim, maxFeeBps);
  if (!finalCheck.ok) return { error: `did not converge: ${finalCheck.why}`, dropped };
  const fails = limitFailures(batch, c);
  if (fails.length) return { error: "limits moved after convergence", dropped: [...dropped, ...fails.map((o) => ({ order: o, reason: "limit not met" }))] };
  return { batch, clearing: c, interactions, sim, dropped, aloneB: ab?.singleOut ?? 0n, aloneA: ba?.singleOut ?? 0n };
}

// --------------------------------------------------------------- settlement

function pendingOf(o: Order): Pending {
  return orders.get(chain.orderHash(o))!;
}

function setStatus(o: Order, s: OrderStatus): void {
  const p = pendingOf(o);
  if (p) p.status = s;
}

function record(r: BatchRecord): void {
  recentBatches.unshift(r);
  if (recentBatches.length > 200) recentBatches.pop();
  try {
    appendFileSync(ledgerFile, json(r) + "\n");
  } catch (e) {
    console.warn(`batcher | could not write ${ledgerFile}: ${(e as Error).message}`);
  }
}

async function settlePair(batch: PairBatch): Promise<void> {
  const solved = await solve(batch);
  for (const d of solved.dropped) {
    stats.rejected++;
    setStatus(d.order, { state: "rejected", reason: d.reason });
    inFlight.delete(chain.orderHash(d.order));
  }
  if ("error" in solved) {
    // Not a rejection of any one order: the whole pair could not be settled this window. Try again.
    for (const o of allOrders(batch)) {
      const p = pendingOf(o);
      if (!p || p.status.state !== "pending") continue;
      p.attempts++;
      if (p.attempts >= MAX_ATTEMPTS) {
        stats.rejected++;
        p.status = { state: "rejected", reason: solved.error };
      }
      inFlight.delete(p.hash);
    }
    console.warn(`batcher | ${batch.a.slice(0, 8)}/${batch.b.slice(0, 8)}: ${solved.error}`);
    return;
  }

  const os = allOrders(solved.batch);
  const sigs = os.map((o) => pendingOf(o).signature);
  const px = prices(solved.batch, solved.clearing);
  const dry = await chain.dryRunSettle(os, sigs, px, solved.interactions);
  if (!dry.ok) {
    for (const o of os) {
      const p = pendingOf(o);
      p.attempts++;
      if (p.attempts >= MAX_ATTEMPTS) {
        stats.rejected++;
        p.status = { state: "rejected", reason: `settlement would revert: ${dry.error}` };
      }
      inFlight.delete(p.hash);
    }
    console.warn(`batcher | dry run failed: ${dry.error}`);
    return;
  }

  let txHash: Hex;
  try {
    txHash = await chain.settle(os, sigs, px, solved.interactions, dry.gas);
  } catch (e) {
    // A refused send is not the orders' fault, but retrying every window is
    // how a rate limit stays hit. Back off for as long as the sequencer says,
    // and count the attempt so a dead path does not hold orders forever.
    const msg = (e as Error).message;
    const m = /reset in (\d+) seconds?/i.exec(msg);
    const pause = /429|rate limit|too many/i.test(msg) ? (m ? Number(m[1]) * 1000 : 5_000) : 2_000;
    sendPausedUntil = Date.now() + pause;
    for (const o of os) {
      const p = pendingOf(o);
      p.attempts++;
      if (p.attempts >= MAX_ATTEMPTS * 2) {
        stats.rejected++;
        p.status = { state: "rejected", reason: `could not submit: ${msg}` };
      }
      inFlight.delete(p.hash);
    }
    console.warn(`batcher | send failed (${msg}); pausing sends ${pause}ms`);
    return;
  }
  for (const o of os) setStatus(o, { state: "settling", txHash });

  const res = residual(solved.batch, solved.clearing);
  const netA = nettedA(solved.batch, solved.clearing);
  const rc = await chain.receipt(txHash);
  const ok = rc?.status === true;
  const ib = solved.sim.tokens.findIndex((t) => t === solved.batch.b);
  const ia = solved.sim.tokens.findIndex((t) => t === solved.batch.a);
  const feeB = ib >= 0 ? solved.sim.delta[ib] - solved.sim.owed[ib] : 0n;
  const feeA = ia >= 0 ? solved.sim.delta[ia] - solved.sim.owed[ia] : 0n;
  record({
    at: Date.now(),
    txHash,
    tokenA: solved.batch.a,
    tokenB: solved.batch.b,
    orders: os.length,
    nettedA: netA,
    residualA: res.a,
    residualB: res.b,
    feeToken: feeB >= feeA ? solved.batch.b : solved.batch.a,
    fee: feeB >= feeA ? feeB : feeA,
    gasUsed: rc?.gasUsed ?? null,
    ok,
  });

  if (ok) {
    stats.batches++;
    const twoSided = solved.batch.sellA.length > 0 && solved.batch.sellB.length > 0;
    for (const o of os) {
      stats.filled++;
      if (twoSided) stats.netted++;
      const alone = os.length === 1 ? (asToken(o.sellToken) === solved.batch.a ? solved.aloneB : solved.aloneA) : null;
      setStatus(o, { state: "filled", txHash, buyAmount: buyAmount(o, solved.batch, solved.clearing), alone, netted: twoSided });
      inFlight.delete(pendingOf(o).hash);
    }
    console.log(
      `batcher | settled ${os.length} order(s) ${solved.batch.a.slice(0, 8)}/${solved.batch.b.slice(0, 8)} netted=${netA} residual=${res.a || res.b} tx=${txHash}`,
    );
  } else {
    stats.batchesFailed++;
    for (const o of os) {
      const p = pendingOf(o);
      p.attempts++;
      p.status = p.attempts >= MAX_ATTEMPTS ? { state: "rejected", reason: rc ? "settlement reverted on-chain" : "settlement not mined" } : { state: "pending" };
      if (p.status.state === "rejected") stats.rejected++;
      inFlight.delete(p.hash);
    }
    console.warn(`batcher | settlement ${txHash} ${rc ? "reverted" : "not mined"}`);
  }
}

// ------------------------------------------------------------------ windows

async function tick(): Promise<void> {
  stats.windows++;
  const now = Math.floor(Date.now() / 1000);
  const ready: Pending[] = [];
  const depositChecks: Pending[] = [];
  for (const p of orders.values()) {
    if (p.status.state === "pending" || p.status.state === "awaiting_deposit") {
      if (p.order.validTo <= now + 1) {
        p.status = { state: "expired" };
        stats.expired++;
        continue;
      }
    }
    if (inFlight.has(p.hash)) continue;
    if (p.status.state === "awaiting_deposit") depositChecks.push(p);
    else if (p.status.state === "pending") ready.push(p);
  }
  if (depositChecks.length) {
    await Promise.all(
      depositChecks.map(async (p) => {
        const esc = await chain.escrowed(p.hash).catch(() => 0n);
        if (esc === p.order.sellAmount) {
          p.status = { state: "pending" };
          ready.push(p);
        }
      }),
    );
  }
  if (ready.length === 0 || Date.now() < sendPausedUntil) return;
  for (const p of ready) inFlight.add(p.hash);
  const batches = groupByPair(ready.map((p) => p.order));
  await chain.refresh().catch(() => {});
  await Promise.all(batches.map((b) => settlePair(b).catch((e) => console.warn(`batcher | pair failed: ${(e as Error).message}`))));
  // Anything still in flight after a pair threw is released for the next window.
  for (const p of ready) inFlight.delete(p.hash);
  // Forget finished orders after ten minutes so the map does not grow forever.
  const cutoff = Date.now() - 10 * 60_000;
  for (const [h, p] of orders) if (p.receivedAt < cutoff && p.status.state !== "pending" && p.status.state !== "settling") orders.delete(h);
}

// ------------------------------------------------------------------- http

// Rendered once; the numbers on it come from this host's own endpoints.
let PAGE = "";

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(json(body));
  };
  if (req.method === "OPTIONS") return send(204, {});
  if (req.method === "GET" && url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
    res.end(PAGE);
    return;
  }
  if (req.method === "GET" && url === "/health") return send(200, { status: "ok", batch: BATCH, solver: chain.account.address, windowMs: WINDOW_MS, feeBps: FEE_BPS, pending: [...orders.values()].filter((p) => p.status.state === "pending").length, sendPausedMs: Math.max(0, sendPausedUntil - Date.now()), stats });
  if (req.method === "GET" && url === "/stats") return send(200, { stats, windowMs: WINDOW_MS, feeBps: FEE_BPS, maxFeeBps, batch: BATCH, solver: chain.account.address });
  if (req.method === "GET" && url === "/batches") return send(200, { batches: recentBatches.slice(0, 50) });
  if (req.method === "GET" && url.startsWith("/order/")) {
    const h = url.slice("/order/".length).toLowerCase() as Hex;
    const p = orders.get(h);
    return p ? send(200, { orderHash: h, status: p.status, order: p.order }) : send(404, { error: "unknown order" });
  }
  if (req.method === "POST" && url === "/order") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        send(200, await intake(JSON.parse(raw)));
      } catch (e) {
        send(400, { error: (e as Error).message });
      }
    });
    return;
  }
  send(404, { error: "not found" });
});

// ------------------------------------------------------------------- start

(async () => {
  try {
    maxFeeBps = await chain.maxFeeBps();
  } catch (e) {
    console.warn(`batcher | could not read maxFeeBps (${(e as Error).message}); assuming ${maxFeeBps}`);
  }
  const bal = await chain.balance().catch(() => 0n);
  PAGE = batchHtml({
    contract: BATCH,
    explorer: "https://robinhoodchain.blockscout.com",
    rpc: "https://rpc.ordofi.network",
    app: "https://app.ordofi.network",
    docs: "https://app.ordofi.network/docs",
    windowMs: WINDOW_MS,
    feeBps: Number(FEE_BPS),
    maxFeeBps: Number(maxFeeBps),
  });
  server.listen(PORT, () => {
    console.log(`Ordo Batch | listening on :${PORT} | contract ${BATCH} | solver ${chain.account.address} (${Number(bal) / 1e18} ETH for gas)`);
    console.log(`Ordo Batch | window ${WINDOW_MS}ms · fee ${FEE_BPS} bps of the clearing amount (cap ${maxFeeBps} bps on-chain) · V4 routes ${v4 ? "on" : "off"}`);
    console.log(`Ordo Batch | POST /order  GET /order/:hash /health /stats /batches`);
  });
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((e) => console.warn(`batcher | tick: ${(e as Error).message}`))
      .finally(() => (running = false));
  }, WINDOW_MS);
})();
