/**
 * ordo_quoteSwap for OrdoSwapV2 (contracts/src/OrdoSwapV2.sol): Uniswap V3
 * and V4, any token that has a pool on either.
 *
 * A route is a list of legs — a V3 hop or a V4 pool — and so is a back-run.
 * The search is the same as v1's, over a bigger set of pools: every V3 tier
 * and every V4 pool of a pair, direct or through ether or USDG. Ether is one
 * asset here with two spellings: WETH on V3, native (address zero) on V4; the
 * contract converts between legs, and this module names it WETH throughout.
 *
 * V4 has no quoter on this chain. The contract's own `quote()` is used
 * instead: it runs the legs for real and reverts with the answer, so an
 * ether-in route is priced with one eth_call carrying the swap as value. A
 * token-in route needs the sender's balance and approval, so it is simulated
 * from their address with eth_simulateV1, and every back-run candidate is
 * priced in the same simulated block with `quoteReclaim` — against the state
 * the swap just left.
 */
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { FEES, V3_FACTORY, ZERO_ADDRESS, encodePath } from "@ordofi/core/arb";
import { RpcError } from "./errors.js";

export const WETH: Hex = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG: Hex = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const NATIVE: Hex = "0x0000000000000000000000000000000000000000";

export const ORDO_SWAP2_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Leg { uint8 venue; bytes path; PoolKey key; bool zeroForOne; }",
  "struct Reclaim { Leg[] legs; uint256 amountIn; uint256 minProfit; uint256 gas; }",
  "function swap(Leg[] legs, uint256 amountIn, uint256 amountOutMinimum, address recipient, bool nativeOut, Reclaim reclaim) payable returns (uint256 amountOut, uint256 surplus)",
  "function quote(Leg[] legs, uint256 amountIn, Reclaim reclaim) payable",
  "function quoteReclaim(Reclaim reclaim)",
  "function float() view returns (uint256)",
  "function protocolBps() view returns (uint16)",
  "error QuoteResult(uint256 amountOut, uint256 reclaimProfit, bytes reclaimFailure)",
]);
const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const ERC20_ABI = parseAbi(["function approve(address, uint256) returns (bool)"]);

export interface PoolKey {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

/** A market for a pair, on either venue. `a`/`b` name ether as WETH. */
export interface Pool {
  venue: "v3" | "v4";
  a: Hex;
  b: Hex;
  fee: number;
  key?: PoolKey;
  hooked?: boolean;
  id: string;
  /** Swaps in the last day, when known (V4 pools with an activity index). */
  swaps?: number;
}

export interface Leg {
  venue: number;
  path: Hex;
  key: PoolKey;
  zeroForOne: boolean;
}

export interface Hop {
  venue: "v3" | "v4";
  tokenIn: Hex;
  tokenOut: Hex;
  fee: number;
  hooked?: boolean;
}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface V4Source {
  /** Every V4 pool for the pair, either order; ether is address zero. */
  v4PoolsForPair(a: string, b: string): { poolId: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }[];
  /** Swaps per pool over the window, for every pool at once. Optional: without it, pools are kept in creation order. */
  poolSwapsAll?(sinceBucket: number): Map<string, number>;
}

/** Most V4 markets kept per pair for a direct swap. Past this the rest are dust pools nobody trades. */
export const MAX_DIRECT_POOLS = 3;
/** Most markets used on each side of a two-hop route. */
export const MAX_VIA_POOLS = 2;

/**
 * Which pools trade, refreshed once a minute off the store's candles. The
 * query walks a day of the candle index (a couple of hundred ms of SQLite,
 * synchronous) — far too slow to run per keystroke, and it blocks the event
 * loop the whole RPC runs on, so it runs here, on a timer, and requests read
 * a Map.
 */
class Activity {
  private swaps = new Map<string, number>();
  private at = 0;
  private refreshing = false;
  constructor(private readonly src: V4Source | null) {}
  of(poolId: string): number {
    this.maybeRefresh();
    return this.swaps.get(poolId.toLowerCase()) ?? 0;
  }
  known(): boolean {
    this.maybeRefresh();
    return this.swaps.size > 0;
  }
  private maybeRefresh(): void {
    if (!this.src?.poolSwapsAll || this.refreshing || Date.now() - this.at < 60_000) return;
    this.refreshing = true;
    // Off the current tick, so the request that noticed staleness is not the one that pays.
    setTimeout(() => {
      try {
        this.swaps = this.src!.poolSwapsAll!(Math.floor(Date.now() / 1000) - 86_400);
        this.at = Date.now();
      } catch {
        /* keep the old ranking */
      } finally {
        this.refreshing = false;
      }
    }, 0).unref?.();
  }
}
const activities = new WeakMap<object, Activity>();
const noSource = new Activity(null);
function activityFor(src: V4Source | null): Activity {
  if (!src) return noSource;
  let a = activities.get(src);
  if (!a) activities.set(src, (a = new Activity(src)));
  return a;
}

export interface SwapRequest {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  amountOutMinimum: bigint;
  recipient: Hex;
  nativeOut: boolean;
  from?: Hex;
}

export interface SwapQuote {
  to: Hex;
  data: Hex;
  value: Hex;
  /** A gas limit that fits the route and the reclaim, with room. */
  gas: Hex;
  amountOut: Hex;
  route: Hop[];
  reclaim: null | {
    route: Hop[];
    amountIn: Hex;
    minProfit: Hex;
    profit: Hex;
    surplusToUser: Hex;
    label: string;
  };
  note?: string;
}

const EMPTY_KEY: PoolKey = { currency0: NATIVE, currency1: NATIVE, fee: 0, tickSpacing: 0, hooks: NATIVE };
const NO_RECLAIM = { legs: [] as Leg[], amountIn: 0n, minProfit: 0n, gas: 0n };
/** Gas a reclaim needs: a fixed part plus each leg (a V4 unlock is the dearer one). */
export const RECLAIM_GAS_BASE = 120_000n;
export const RECLAIM_GAS_PER_LEG = 180_000n;
const SWAP_GAS_BASE = 160_000n;
const SWAP_GAS_PER_LEG = 170_000n;
const WORTH_IT = 3n;
// Three rungs, not five: each rung is a full simulation per candidate, and the
// profit curve is smooth enough that 10% / 40% / 100% of the cap finds the
// right neighbourhood. Instant beats exact here.
const LADDER_PERMILLE = [100n, 400n, 1000n];
/** Most back-run candidates simulated for one swap. */
const MAX_RECLAIM_CANDIDATES = 4;
const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
const low = (a: string) => a.toLowerCase() as Hex;
const isEther = (a: string) => low(a) === WETH || low(a) === NATIVE;

// ----------------------------------------------------------------- pools

const tierCache = new Map<string, { tiers: number[]; at: number }>();
async function v3Tiers(rpc: Rpc, a: Hex, b: Hex): Promise<number[]> {
  const key = [low(a), low(b)].sort().join(":");
  const hit = tierCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.tiers;
  const hits = await Promise.all(
    FEES.map(async (fee) => {
      try {
        const out = (await rpc("eth_call", [{ to: V3_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] }) }, "latest"])) as Hex;
        return (decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: out }) as string).toLowerCase() === ZERO_ADDRESS ? null : fee;
      } catch {
        return null;
      }
    }),
  );
  const tiers = hits.filter((f): f is number => f !== null);
  tierCache.set(key, { tiers, at: Date.now() });
  return tiers;
}

const pairCache = new Map<string, { pools: Pool[]; at: number }>();
const PAIR_TTL_MS = 60_000;

/**
 * Every market for (a, b) worth quoting: all V3 tiers, and the V4 pools that
 * actually trade — ranked by the last day's swaps, busiest first, at most
 * `MAX_DIRECT_POOLS`. Ether may be given as WETH. Cached a minute per pair, so
 * a keystroke never pays for discovery twice.
 */
export async function poolsFor(rpc: Rpc, v4: V4Source | null, a: Hex, b: Hex): Promise<Pool[]> {
  a = low(a); b = low(b);
  if (isEther(a)) a = WETH;
  if (isEther(b)) b = WETH;
  if (a === b) return [];
  const ck = [a, b].sort().join(":") + (v4 ? "" : ":nov4");
  const hit = pairCache.get(ck);
  if (hit && Date.now() - hit.at < PAIR_TTL_MS) return hit.pools.map((p) => (p.a === a ? p : { ...p, a, b }));
  const out: Pool[] = [];
  for (const fee of await v3Tiers(rpc, a, b)) out.push({ venue: "v3", a, b, fee, id: `v3:${ck}:${fee}` });
  if (v4) {
    const act = activityFor(v4);
    // V4 spells ether as address zero.
    let rows = v4.v4PoolsForPair(a === WETH ? NATIVE : a, b === WETH ? NATIVE : b);
    if (act.known()) {
      // Hundreds of pools can exist for one pair; a handful are markets.
      rows = [...rows].sort((x, y) => act.of(y.poolId) - act.of(x.poolId));
      const live = rows.filter((r) => act.of(r.poolId) > 0);
      rows = (live.length ? live : rows.slice(0, 1)).slice(0, MAX_DIRECT_POOLS);
    } else {
      rows = rows.slice(0, MAX_DIRECT_POOLS);
    }
    for (const p of rows) {
      out.push({
        venue: "v4",
        a, b,
        fee: p.fee,
        key: { currency0: low(p.currency0), currency1: low(p.currency1), fee: p.fee, tickSpacing: p.tickSpacing, hooks: low(p.hooks) },
        hooked: low(p.hooks) !== NATIVE,
        id: `v4:${p.poolId.toLowerCase()}`,
        swaps: act.of(p.poolId),
      });
    }
  }
  pairCache.set(ck, { pools: out, at: Date.now() });
  return out;
}

/** The pools worth using as one side of a two-hop route: the busiest few. */
function viaPools(pools: Pool[]): Pool[] {
  // V3 tiers have no activity figure here; keep the deepest-typical ones first (0.01%, 0.05%), then V4 by swaps.
  const v3 = pools.filter((p) => p.venue === "v3").sort((x, y) => x.fee - y.fee);
  const v4 = pools.filter((p) => p.venue === "v4").sort((x, y) => (y.swaps ?? 0) - (x.swaps ?? 0));
  return [...v3, ...v4].slice(0, MAX_VIA_POOLS);
}

/** Warm the activity ranking at boot so the first quote is not the one that pays for it. */
export function warm(v4: V4Source | null): void {
  activityFor(v4).known();
}

/** Forget every cached pair and tier. For tests, which share this module. */
export function resetCaches(): void {
  pairCache.clear();
  tierCache.clear();
  briefCache.clear();
}

/** The leg that swaps `tokenIn` for the other side of `pool`. */
export function legFor(pool: Pool, tokenIn: Hex): Leg {
  tokenIn = isEther(tokenIn) ? WETH : low(tokenIn);
  const tokenOut = pool.a === tokenIn ? pool.b : pool.a;
  if (pool.venue === "v3") return { venue: 0, path: encodePath([tokenIn, tokenOut], [pool.fee]), key: EMPTY_KEY, zeroForOne: false };
  const k = pool.key!;
  const cIn = tokenIn === WETH && (k.currency0 === NATIVE || k.currency1 === NATIVE) ? NATIVE : tokenIn;
  return { venue: 1, path: "0x", key: k, zeroForOne: low(k.currency0) === cIn };
}

export function hopFor(pool: Pool, tokenIn: Hex): Hop {
  tokenIn = isEther(tokenIn) ? WETH : low(tokenIn);
  return { venue: pool.venue, tokenIn, tokenOut: pool.a === tokenIn ? pool.b : pool.a, fee: pool.fee, hooked: pool.hooked };
}

// ---------------------------------------------------------------- routes

export interface Route {
  pools: Pool[];
  legs: Leg[];
  hops: Hop[];
}

function routeOf(pools: Pool[], tokenIn: Hex): Route {
  const legs: Leg[] = [];
  const hops: Hop[] = [];
  let cur = isEther(tokenIn) ? WETH : low(tokenIn);
  for (const p of pools) {
    legs.push(legFor(p, cur));
    const h = hopFor(p, cur);
    hops.push(h);
    cur = h.tokenOut;
  }
  return { pools, legs, hops };
}

/** Direct markets plus two-hop routes through ether or USDG. */
export async function candidateRoutes(rpc: Rpc, v4: V4Source | null, tokenIn: Hex, tokenOut: Hex): Promise<Route[]> {
  tokenIn = isEther(tokenIn) ? WETH : low(tokenIn);
  tokenOut = isEther(tokenOut) ? WETH : low(tokenOut);
  const [direct, ...viaPairs] = await Promise.all([
    poolsFor(rpc, v4, tokenIn, tokenOut),
    ...[WETH, USDG].flatMap((mid) => (mid === tokenIn || mid === tokenOut ? [] : [poolsFor(rpc, v4, tokenIn, mid), poolsFor(rpc, v4, mid, tokenOut)])),
  ]);
  const routes: Route[] = direct.map((p) => routeOf([p], tokenIn));
  for (let i = 0; i < viaPairs.length; i += 2) {
    for (const p1 of viaPools(viaPairs[i])) for (const p2 of viaPools(viaPairs[i + 1])) routes.push(routeOf([p1, p2], tokenIn));
  }
  return routes;
}

// ---------------------------------------------------------------- quoting

export function decodeQuote(revertData: Hex): { amountOut: bigint; profit: bigint; failed: boolean } | null {
  try {
    const d = decodeErrorResult({ abi: ORDO_SWAP2_ABI, data: revertData });
    if (d.errorName !== "QuoteResult") return null;
    const [amountOut, profit, failure] = d.args as [bigint, bigint, Hex];
    return { amountOut, profit, failed: failure !== "0x" && failure.length > 2 };
  } catch {
    return null;
  }
}

function revertBytes(err: unknown): Hex | null {
  const e = err as { data?: unknown; message?: string };
  for (const c of [e?.data, (e?.data as { data?: unknown })?.data]) if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c as Hex;
  const m = /(0x[0-9a-fA-F]{8,})/.exec(e?.message ?? "");
  return m ? (m[1] as Hex) : null;
}

/** One `quote()` eth_call; the value stands in for an ether input. */
async function quoteCall(rpc: Rpc, ordoSwap: Hex, legs: Leg[], amountIn: bigint, reclaim: typeof NO_RECLAIM, valueFrom: Hex | null) {
  const data = encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "quote", args: [legs, amountIn, reclaim] });
  try {
    await rpc("eth_call", [valueFrom ? { from: valueFrom, to: ordoSwap, data, value: hex(amountIn) } : { to: ordoSwap, data }, "latest"]);
    return null;
  } catch (e) {
    const b = revertBytes(e);
    return b ? decodeQuote(b) : null;
  }
}

export function sizeLadder(float: bigint, cap: bigint): bigint[] {
  const max = float < cap ? float : cap;
  return [...new Set(LADDER_PERMILLE.map((p) => (max * p) / 1000n).filter((s) => s > 0n).map(String))].map(BigInt);
}

/**
 * The back-runs a single-hop swap against ether could open. Buying `token`
 * on pool P makes it dear on P: buy it anywhere else, sell into P. Selling is
 * the mirror. The "anywhere else" is every other market of the pair, plus a
 * detour through USDG when the token has depth there.
 */
export function reclaimCandidates(swapped: Pool, token: Hex, buying: boolean, etherPools: Pool[], usdgPools: Pool[], etherUsdg: Pool | undefined): Route[] {
  const out: Route[] = [];
  for (const other of etherPools) {
    if (other.id === swapped.id) continue;
    out.push(buying ? routeOf([other, swapped], WETH) : routeOf([swapped, other], WETH));
  }
  if (etherUsdg) {
    for (const u of usdgPools) {
      out.push(buying ? routeOf([etherUsdg, u, swapped], WETH) : routeOf([swapped, u, etherUsdg], WETH));
    }
  }
  return out;
}

export function chooseReclaim(results: { route: Route; size: bigint; profit: bigint }[], gasPrice: bigint, protocolBps: bigint) {
  let best: { route: Route; size: bigint; profit: bigint } | null = null;
  for (const r of results) if (r.profit > 0n && (!best || r.profit > best.profit)) best = r;
  if (!best) return null;
  const gasUnits = RECLAIM_GAS_BASE + RECLAIM_GAS_PER_LEG * BigInt(best.route.legs.length);
  const gas = gasUnits * gasPrice;
  const userShare = (best.profit * (10_000n - protocolBps)) / 10_000n;
  if (userShare < gas * WORTH_IT) return null;
  return { route: best.route, amountIn: best.size, minProfit: best.profit / 2n, profit: best.profit, gasUnits };
}

export interface QuoteDeps {
  rpc: Rpc;
  ordoSwap: Hex;
  v4: V4Source | null;
  valueSource?: Hex;
}

const label = (hops: Hop[], sym: (a: Hex) => string) =>
  hops.map((h, i) => `${i === 0 ? sym(h.tokenIn) : ""}→${sym(h.tokenOut)} ${h.venue === "v4" ? (h.fee === 0x800000 ? "V4·hook" : `V4 ${h.fee / 10000}%`) : `${h.fee / 10000}%`}`).join(" ");

export async function quoteSwap(req: SwapRequest, deps: QuoteDeps): Promise<SwapQuote> {
  const { rpc, ordoSwap, v4 } = deps;
  const tokenIn = isEther(req.tokenIn) ? WETH : low(req.tokenIn);
  const tokenOut = isEther(req.tokenOut) ? WETH : low(req.tokenOut);
  if (tokenIn === tokenOut) throw new RpcError(-32602, "ordo_quoteSwap: tokenIn and tokenOut are the same");
  if (req.amountIn <= 0n) throw new RpcError(-32602, "ordo_quoteSwap: amountIn must be positive");
  if (req.nativeOut && tokenOut !== WETH) throw new RpcError(-32602, "ordo_quoteSwap: nativeOut requires tokenOut to be ETH/WETH");
  const etherIn = tokenIn === WETH;
  if (!etherIn && !req.from) throw new RpcError(-32602, "ordo_quoteSwap: token-in swaps need `from` (the sender) to simulate");

  const [routes, floatHex, bpsHex, gasPriceHex] = await Promise.all([
    candidateRoutes(rpc, v4, tokenIn, tokenOut),
    brief(`float:${ordoSwap}`, () => rpc("eth_call", [{ to: ordoSwap, data: encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "float" }) }, "latest"])),
    brief(`bps:${ordoSwap}`, () => rpc("eth_call", [{ to: ordoSwap, data: encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "protocolBps" }) }, "latest"])),
    brief("gasPrice", () => rpc("eth_gasPrice", [])),
  ]);
  if (routes.length === 0) throw new RpcError(-32000, "ordo_quoteSwap: no route — this pair has no Uniswap V3 or V4 pool, directly or through ETH or USDG");
  const float = BigInt(floatHex as string);
  const protocolBps = BigInt(bpsHex as string);
  const gasPrice = BigInt(gasPriceHex as string);
  const sym = (a: Hex) => (a === WETH ? "ETH" : a === USDG ? "USDG" : a === tokenIn ? "in" : a === tokenOut ? "out" : a.slice(0, 6));

  // ---- the route: price every candidate, keep the best ----
  let best: { route: Route; out: bigint } | null = null;
  if (etherIn) {
    const priced = await Promise.all(routes.map(async (route) => ({ route, q: await quoteCall(rpc, ordoSwap, route.legs, req.amountIn, NO_RECLAIM, deps.valueSource ?? WETH) })));
    for (const p of priced) if (p.q && p.q.amountOut > 0n && (!best || p.q.amountOut > best.out)) best = { route: p.route, out: p.q.amountOut };
  } else {
    // Token in: the contract holds none of it, so each route is simulated from
    // the sender — one simulation per route, because blocks inside one
    // eth_simulateV1 build on each other and every route must see the same state.
    const blocks = await Promise.all(
      routes.map((route) => simulate(rpc, [[approveCall(req.from!, tokenIn, ordoSwap, req.amountIn), swapCall(req.from!, ordoSwap, route.legs, req.amountIn, req.recipient, req.nativeOut)]]).then((b) => b[0]).catch(() => [] as SimCall[])),
    );
    blocks.forEach((calls, i) => {
      const s = calls[1];
      if (!s || s.status !== "0x1" || !s.returnData) return;
      const [out] = decodeFunctionResult({ abi: ORDO_SWAP2_ABI, functionName: "swap", data: s.returnData }) as [bigint, bigint];
      if (out > 0n && (!best || out > best.out)) best = { route: routes[i], out };
    });
    if (!best) {
      // The sender cannot make this swap right now (no balance or approval yet). Price it from the contract's side for display.
      const priced = await Promise.all(routes.map(async (route) => ({ route, q: await quoteCall(rpc, ordoSwap, route.legs, req.amountIn, NO_RECLAIM, null) })));
      for (const p of priced) if (p.q && p.q.amountOut > 0n && (!best || p.q.amountOut > best.out)) best = { route: p.route, out: p.q.amountOut };
      if (best) return plain(req, ordoSwap, best, "connect a wallet that holds the token and has approved the contract to see what would come back");
      throw new RpcError(-32000, "ordo_quoteSwap: the swap cannot be priced — no route returns anything for this amount");
    }
  }
  if (!best) throw new RpcError(-32000, "ordo_quoteSwap: no route returns anything for this amount");
  const chosen: { route: Route; out: bigint } = best;

  // ---- the back-run: only for a single hop against ether ----
  const single = chosen.route.pools.length === 1;
  const etherOut = tokenOut === WETH;
  if (!single || (!etherIn && !etherOut)) {
    return plain(req, ordoSwap, chosen, single ? "back-run search covers single-hop swaps against ETH (v1)" : `back-run search covers single-hop swaps; this one routes through ${chosen.route.hops[0].tokenOut === USDG ? "USDG" : "ETH"}`);
  }
  const token = etherIn ? tokenOut : tokenIn;
  const [etherPools, usdgPools, etherUsdgPools] = await Promise.all([poolsFor(rpc, v4, WETH, token), token === USDG ? [] : poolsFor(rpc, v4, USDG, token), poolsFor(rpc, v4, WETH, USDG)]);
  const etherUsdg = etherUsdgPools.find((p) => p.venue === "v3" && p.fee === 100) ?? etherUsdgPools[0];
  const candidates = reclaimCandidates(chosen.route.pools[0], token, etherIn, etherPools, usdgPools, etherUsdg).slice(0, MAX_RECLAIM_CANDIDATES);
  const sizes = sizeLadder(float, req.amountIn);
  if (candidates.length === 0 || sizes.length === 0) {
    return plain(req, ordoSwap, chosen, candidates.length === 0 ? "this token has one market; a swap on it opens no cross-market gap" : "reclaim float is empty");
  }
  const tries = candidates.flatMap((route) => sizes.map((size) => ({ route, size })));
  const results: { route: Route; size: bigint; profit: bigint }[] = [];
  if (etherIn) {
    await Promise.all(
      tries.map(async ({ route, size }) => {
        const q = await quoteCall(rpc, ordoSwap, chosen.route.legs, req.amountIn, { legs: route.legs, amountIn: size, minProfit: 0n, gas: 0n }, deps.valueSource ?? WETH);
        if (q && !q.failed && q.profit > 0n) results.push({ route, size, profit: q.profit });
      }),
    );
  } else {
    const calls = [
      approveCall(req.from!, tokenIn, ordoSwap, req.amountIn),
      swapCall(req.from!, ordoSwap, chosen.route.legs, req.amountIn, req.recipient, req.nativeOut),
      ...tries.map(({ route, size }) => ({ from: ordoSwap, to: ordoSwap, data: encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "quoteReclaim", args: [{ legs: route.legs, amountIn: size, minProfit: 0n, gas: 0n }] }) })),
    ];
    const [calls_] = await simulate(rpc, [calls]);
    tries.forEach(({ route, size }, i) => {
      const r = calls_[i + 2];
      const bytes = r?.returnData ?? (r?.error?.data as Hex | undefined);
      const q = bytes ? decodeQuote(bytes) : null;
      if (q && !q.failed && q.profit > 0n) results.push({ route, size, profit: q.profit });
    });
  }
  const reclaim = chooseReclaim(results, gasPrice, protocolBps);
  if (!reclaim) {
    const bestP = results.reduce((m, r) => (r.profit > m ? r.profit : m), 0n);
    return plain(req, ordoSwap, chosen, bestP > 0n ? "the gap this swap opens does not cover the gas of closing it" : "this swap opens no cross-market gap");
  }
  const surplusToUser = (reclaim.profit * (10_000n - protocolBps)) / 10_000n;
  const r = { legs: reclaim.route.legs, amountIn: reclaim.amountIn, minProfit: reclaim.minProfit, gas: reclaim.gasUnits };
  return {
    to: ordoSwap,
    data: encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "swap", args: [chosen.route.legs, req.amountIn, req.amountOutMinimum, req.recipient, req.nativeOut, r] }),
    value: etherIn ? hex(req.amountIn) : "0x0",
    gas: hex(SWAP_GAS_BASE + SWAP_GAS_PER_LEG * BigInt(chosen.route.legs.length) + reclaim.gasUnits + 60_000n),
    amountOut: hex(chosen.out),
    route: chosen.route.hops,
    reclaim: {
      route: reclaim.route.hops,
      amountIn: hex(reclaim.amountIn),
      minProfit: hex(reclaim.minProfit),
      profit: hex(reclaim.profit),
      surplusToUser: hex(surplusToUser),
      label: label(reclaim.route.hops, sym),
    },
  };
}

function plain(req: SwapRequest, ordoSwap: Hex, chosen: { route: Route; out: bigint }, note: string): SwapQuote {
  const etherIn = isEther(req.tokenIn);
  return {
    to: ordoSwap,
    data: encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "swap", args: [chosen.route.legs, req.amountIn, req.amountOutMinimum, req.recipient, req.nativeOut, NO_RECLAIM] }),
    value: etherIn ? hex(req.amountIn) : "0x0",
    gas: hex(SWAP_GAS_BASE + SWAP_GAS_PER_LEG * BigInt(chosen.route.legs.length) + 40_000n),
    amountOut: hex(chosen.out),
    route: chosen.route.hops,
    reclaim: null,
    note,
  };
}

// --------------------------------------------------------------- helpers

const approveCall = (from: Hex, token: Hex, spender: Hex, amount: bigint) => ({ from, to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }) });
const swapCall = (from: Hex, ordoSwap: Hex, legs: Leg[], amountIn: bigint, recipient: Hex, nativeOut: boolean) => ({
  from,
  to: ordoSwap,
  data: encodeFunctionData({ abi: ORDO_SWAP2_ABI, functionName: "swap", args: [legs, amountIn, 0n, recipient, nativeOut, NO_RECLAIM] }),
});

interface SimCall {
  status?: string;
  returnData?: Hex;
  error?: { message?: string; data?: unknown };
}

/** eth_simulateV1: each inner array is one block of calls run in order against the same evolving state. */
async function simulate(rpc: Rpc, blocks: { from: Hex; to: Hex; data: Hex; value?: Hex }[][]): Promise<SimCall[][]> {
  let res: any;
  try {
    res = await rpc("eth_simulateV1", [{ blockStateCalls: blocks.map((calls) => ({ calls })), validation: false, traceTransfers: false }, "latest"]);
  } catch (e) {
    throw new RpcError(-32000, `ordo_quoteSwap: could not simulate — ${(e as Error).message}`);
  }
  return (res ?? []).map((b: any) => b?.calls ?? []);
}

const briefCache = new Map<string, { v: Promise<unknown>; at: number }>();
function brief(key: string, load: () => Promise<unknown>, ttlMs = 3_000): Promise<unknown> {
  const hit = briefCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = load();
  briefCache.set(key, { v, at: Date.now() });
  v.catch(() => briefCache.delete(key));
  return v;
}
