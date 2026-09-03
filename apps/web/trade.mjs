/**
 * The read side of the trade terminal: token discovery, quotes, swap calldata,
 * and chart candles — all straight from the chain.
 *
 * Everything here is advisory. The server never holds keys and never sends a
 * transaction; it prepares calldata that the user's own wallet signs and
 * submits through the protected RPC. Quotes come from Uniswap V3's QuoterV2
 * (the canonical Robinhood Chain deployment), candles from the pool's own
 * Swap events, and the token list from the pools the watcher actually sees
 * trading. No third-party price API is involved anywhere.
 *
 * Routing is Uniswap V3 only for now. Our own venue attribution says most
 * stock-token and WETH/USDG liquidity sits there; V4 routing needs the
 * Universal Router's command encoding and comes later.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, decodeFunctionResult, encodePacked, toEventSelector } from "viem";
import { rpcFetch, V4, isV4PoolId } from "@ordofi/core";
import { getTokenInfo, toWhole } from "@ordofi/core/pricing";
import { ROUTER as SWAP_ROUTER, encodeExactInputSwap } from "@ordofi/core/router";
import { proveDelivery, proofToJson } from "@ordofi/core/guard";

const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../data");
const EXPLORER_API = "https://robinhoodchain.blockscout.com/api/v2";
const EXPLORER_HEADERS = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) ordofi-app" };

export const CHAIN = {
  id: 4663,
  idHex: "0x1237",
  name: "Robinhood Chain",
  rpc: process.env.ORDO_PUBLIC_RPC ?? "https://rpc.ordofi.network",
  explorer: "https://robinhoodchain.blockscout.com",
};

export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const QUOTER_V2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
export const ROUTER = SWAP_ROUTER; // SwapRouter02
const FEES = [100, 500, 3000, 10000];
// Swap calldata is encoded by @ordofi/core/router, which knows which
// SwapRouter02 calls resolve the MSG_SENDER/ADDRESS_THIS sentinels and which
// take a recipient literally. Never hand-roll unwrapWETH9 or sweepToken here.
export const NATIVE = "eth";

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
];

const POOL_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { type: "bytes", name: "path" },
      { type: "uint256", name: "amountIn" },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160[]", name: "sqrtPriceX96AfterList" },
      { type: "uint32[]", name: "initializedTicksCrossedList" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
];

async function call(to, abi, functionName, args = []) {
  const data = await rpcFetch("eth_call", [
    { to, data: encodeFunctionData({ abi, functionName, args }) },
    "latest",
  ]);
  return decodeFunctionResult({ abi, functionName, data });
}

// ---------------------------------------------------------------------------
// Small JSON files under data/: survive restarts, never block a request
// ---------------------------------------------------------------------------

function loadJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(file, value) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  } catch {
    /* read-only disk — the in-memory copy still serves */
  }
}

async function explorerJson(path, timeoutMs = 12_000) {
  const r = await fetch(`${EXPLORER_API}${path}`, { headers: EXPLORER_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Persistent resolvers: look something up once, remember it across restarts
// ---------------------------------------------------------------------------
//
// Robinhood Chain has ~425k Uniswap V3 pools (a launchpad mints one per
// token), so nothing here enumerates the factory. Instead every fact is
// resolved on first sight — pool composition, token metadata, which tiers a
// token has against ETH/USDG — and kept in data/*.json. Misses are remembered
// too, with a timestamp, so a dead contract is not re-asked every rebuild.

class Resolver {
  constructor(file, resolve, { concurrency = 4, retryMissMs = 86_400_000 } = {}) {
    this.file = file;
    this.resolve = resolve;
    this.concurrency = concurrency;
    this.retryMissMs = retryMissMs;
    this.cache = new Map(Object.entries(loadJson(file, {})));
    this.queue = [];
    this.queued = new Set();
    this.worker = null;
    this.dirty = false;
    this.onDrained = null;
  }
  get(key) {
    const v = this.cache.get(key);
    if (v?.miss && Date.now() - v.at > this.retryMissMs) return undefined; // stale miss: ask again
    return v;
  }
  has(key) { return this.get(key) !== undefined; }
  enqueue(key) {
    if (this.has(key) || this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    if (!this.worker) this.worker = this.run().finally(() => { this.worker = null; });
  }
  /** Resolve now (used by on-demand lookups); still cached like the rest. */
  async fetch(key) {
    const hit = this.get(key);
    if (hit) return hit;
    const v = await this.lookup(key);
    this.save(true);
    return v;
  }
  async lookup(key) {
    let v;
    try { v = await this.resolve(key); } catch { v = null; }
    v = v ?? { miss: true, at: Date.now() };
    this.cache.set(key, v);
    this.dirty = true;
    return v;
  }
  async run() {
    let sinceSave = 0;
    const lane = async () => {
      while (this.queue.length) {
        const key = this.queue.shift();
        this.queued.delete(key);
        await this.lookup(key);
        if (++sinceSave >= 50) { sinceSave = 0; this.save(); }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, lane));
    this.save();
    this.onDrained?.();
  }
  save(force = false) {
    if (!this.dirty && !force) return;
    saveJson(this.file, Object.fromEntries(this.cache));
    this.dirty = false;
  }
  get size() { return this.cache.size; }
  get pending() { return this.queue.length; }
}

const goodSymbol = (s) => typeof s === "string" && s.trim().length > 0 && s.trim().length <= 12 && !/^0x[0-9a-f]{6}$/i.test(s);
const money = new Set([WETH, USDG]);

/** Pool composition and provenance. Only factory pools are routable. */
const pools = new Resolver(join(DATA_DIR, "pools.json"), async (pool) => {
  const [t0, t1, fee, factory] = await Promise.all([
    call(pool, POOL_ABI, "token0"),
    call(pool, POOL_ABI, "token1"),
    call(pool, POOL_ABI, "fee"),
    call(pool, POOL_ABI, "factory").catch(() => null),
  ]);
  return { pool, token0: t0.toLowerCase(), token1: t1.toLowerCase(), fee: Number(fee), v3: (factory ?? "").toLowerCase() === V3_FACTORY };
}, { concurrency: 4, retryMissMs: 7 * 86_400_000 });

/**
 * One shape for every pool the tape knows, whichever Uniswap it lives in.
 *
 * V3 pools are addresses, described by the resolver above (unknown ones are
 * queued and join the next build). V4 pools are PoolIds inside the singleton;
 * their keys come from the Initialize events the watcher records, never from
 * an eth_call — a PoolId is not an address and asking one for token0() would
 * only fill pools.json with misses. Native ETH in a V4 key is reported as
 * WETH here so every reader prices and names it the way it already does.
 */
export function describePools(store, keys) {
  const out = new Map();
  const v4Ids = [];
  for (const k of keys) {
    const key = k.toLowerCase();
    if (isV4PoolId(key)) { v4Ids.push(key); continue; }
    const p = pools.get(key);
    if (!p) { pools.enqueue(key); continue; }
    if (p.miss || !p.v3) { out.set(key, null); continue; }
    out.set(key, { pool: key, kind: "v3", token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: null, hooks: null, native0: false });
  }
  if (v4Ids.length && store?.v4PoolsByIds) {
    for (const [id, p] of store.v4PoolsByIds(v4Ids)) out.set(id, v4Shape(p));
    for (const id of v4Ids) if (!out.has(id)) out.set(id, undefined); // not announced yet: the Initialize walk is still running
  }
  return out;
}

export function v4Shape(p) {
  if (!p) return null;
  const native0 = p.currency0 === V4.nativeCurrency;
  return {
    pool: p.poolId, kind: "v4",
    token0: native0 ? WETH : p.currency0, token1: p.currency1,
    // A hook-set fee is not a tier; readers that multiply volume by it get null.
    fee: p.fee === V4.dynamicFeeFlag ? null : p.fee,
    dynamicFee: p.fee === V4.dynamicFeeFlag,
    tickSpacing: p.tickSpacing, hooks: p.hooks === V4.nativeCurrency ? null : p.hooks, native0,
  };
}

function normalizeExplorerToken(t) {
  const address = (t.address_hash ?? t.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  const symbol = (t.symbol ?? "").trim();
  if (!goodSymbol(symbol)) return null;
  return {
    address,
    symbol,
    name: (t.name ?? "").slice(0, 48) || null,
    decimals: Number(t.decimals ?? 18) || 18,
    icon: t.icon_url ?? null,
    usd: t.exchange_rate != null ? Number(t.exchange_rate) : null,
    holders: Number(t.holders_count ?? t.holders ?? 0) || 0,
    at: Date.now(),
  };
}

/** Token metadata: the explorer's registry first, the contract itself second. */
const meta = new Resolver(join(DATA_DIR, "token-meta.json"), async (address) => {
  try {
    const n = normalizeExplorerToken(await explorerJson(`/tokens/${address}`, 9_000));
    if (n) return n;
  } catch {
    /* fall through to the contract */
  }
  const info = await getTokenInfo(address);
  if (!goodSymbol(info.symbol)) return null;
  return { address, symbol: info.symbol, name: null, decimals: info.decimals, icon: null, usd: info.usdPerToken ?? null, holders: 0, at: Date.now() };
}, { concurrency: 3 });

/** Which fee tiers a token has against ETH and USDG — i.e. whether the router can reach it. */
const routes = new Resolver(join(DATA_DIR, "routes.json"), async (token) => {
  const tiers = async (other) => {
    const out = [];
    for (const fee of FEES) {
      try {
        const p = (await call(V3_FACTORY, FACTORY_ABI, "getPool", [other, token, fee])).toLowerCase();
        if (p !== "0x0000000000000000000000000000000000000000") out.push(fee);
      } catch { /* tier absent */ }
    }
    return out;
  };
  const [weth, usdg] = await Promise.all([tiers(WETH), tiers(USDG)]);
  return { token, weth, usdg, at: Date.now() };
}, { concurrency: 3 });

/** True/false when known, null while the check is still queued. */
function routable(token) {
  if (money.has(token)) return true;
  const r = routes.get(token);
  if (!r || r.miss) { routes.enqueue(token); return null; }
  return r.weth.length + r.usdg.length > 0;
}

export function resolverStats() {
  return {
    pools: { known: pools.size, pending: pools.pending },
    tokens: { known: meta.size, pending: meta.pending },
    routes: { known: routes.size, pending: routes.pending },
  };
}

/** The explorer's ERC-20 list, most-held first. */
async function explorerTokenPages(pages) {
  const out = [];
  let params = "";
  for (let i = 0; i < pages; i++) {
    const d = await explorerJson(`/tokens?type=ERC-20${params}`, 9_000);
    for (const t of d.items ?? []) {
      const n = normalizeExplorerToken(t);
      if (n) out.push(n);
    }
    if (!d.next_page_params) break;
    params = "&" + new URLSearchParams(d.next_page_params).toString();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token list: everything the router can reach, ranked by evidence of trading
// ---------------------------------------------------------------------------

const TOKEN_LIST_FILE = join(DATA_DIR, "token-list.json");
// The last list we built, restored stale so a restart answers instantly and
// rebuilds behind the first request instead of making it wait.
let tokenCache = (() => { const saved = loadJson(TOKEN_LIST_FILE, null); return Array.isArray(saved) && saved.length ? { at: 0, list: saved } : null; })();
let tokenRefreshing = null;

/**
 * Stale-while-revalidate: the list takes dozens of round-trips to build, so a
 * cold cache must never block the page. Serve whatever we have and rebuild in
 * the background; only the very first call on a fresh install ever waits.
 */
export async function tradeTokens(store) {
  const stale = !tokenCache || Date.now() - tokenCache.at >= 300_000;
  if (stale && !tokenRefreshing) {
    tokenRefreshing = buildTokenList(store)
      .then((list) => { tokenCache = { at: Date.now(), list }; saveJson(TOKEN_LIST_FILE, list); })
      .catch(() => { /* keep the stale list */ })
      .finally(() => { tokenRefreshing = null; });
  }
  if (tokenCache) return tokenCache.list;
  await tokenRefreshing;
  return tokenCache?.list ?? [];
}

const IMPORTED_FILE = join(DATA_DIR, "imported-tokens.json");
const imported = new Set(loadJson(IMPORTED_FILE, []));

/** Pools the recorder saw trading in the last day (busiest first), plus the arb-contested set. */
function activePoolList(store) {
  const since = Math.floor(Date.now() / 1000) - 86_400;
  const seen = new Set();
  const out = [];
  for (const r of store?.marketStats?.(since) ?? []) {
    const p = r.pool.toLowerCase();
    if (!seen.has(p)) { seen.add(p); out.push({ pool: p, swaps: r.swaps }); }
  }
  for (const { pool, count } of store?.topPools?.(60) ?? []) {
    const p = pool.toLowerCase();
    if (!seen.has(p)) { seen.add(p); out.push({ pool: p, swaps: count }); }
  }
  return out;
}

function tokenRow(address, m, extra = {}) {
  return {
    address,
    symbol: m.symbol,
    name: m.name ?? null,
    decimals: m.decimals,
    usdPerToken: m.usd ?? m.usdPerToken ?? null,
    icon: m.icon ?? null,
    holders: m.holders ?? 0,
    ...extra,
  };
}

async function buildTokenList(store) {
  const seen = new Map();
  const activity = new Map(); // token -> swaps in active pools
  const moneyPaired = new Set(); // tokens with a factory pool against ETH/USDG

  // 1. Pools that demonstrably traded today. Composition comes from the pool
  //    cache; unknown pools are queued busiest-first and join the next build.
  const active0 = activePoolList(store);
  const described = describePools(store, active0.map((a) => a.pool));
  for (const { pool, swaps } of active0) {
    const info = described.get(pool);
    if (!info) continue;
    for (const [tok, other] of [[info.token0, info.token1], [info.token1, info.token0]]) {
      activity.set(tok, (activity.get(tok) ?? 0) + swaps);
      if (money.has(other)) moneyPaired.add(tok);
    }
  }

  // 2. The core pair is always described from the chain itself.
  for (const a of [WETH, USDG]) {
    try {
      const info = await getTokenInfo(a);
      seen.set(a, { address: a, symbol: info.symbol, decimals: info.decimals, usdPerToken: info.usdPerToken, active: true });
    } catch { /* the explorer pass will still describe it */ }
  }

  // 3. Active tokens, busiest first, from cached metadata.
  const active = [...activity.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const ACTIVE_MIN_SWAPS = 5; // one launchpad swap is not "trading"
  for (const tok of active) {
    if (seen.has(tok)) continue;
    const m = meta.get(tok);
    if (!m) { meta.enqueue(tok); continue; }
    if (m.miss) continue;
    seen.set(tok, tokenRow(tok, m, { active: (activity.get(tok) ?? 0) >= ACTIVE_MIN_SWAPS }));
  }
  // The busiest few get the chain-derived price, which beats the explorer's.
  {
    const top = active.slice(0, 40).filter((t) => seen.has(t));
    let i = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (i < top.length) {
        const tok = top[i++];
        try {
          const info = await getTokenInfo(tok);
          if (info.usdPerToken) seen.get(tok).usdPerToken = info.usdPerToken;
        } catch { /* keep the explorer's number */ }
      }
    }));
  }

  // 4. The explorer's most-held tokens: names, icons, prices, holder counts,
  //    and the long tail of listed-but-quiet assets for the search box.
  try {
    for (const t of await explorerTokenPages(12)) {
      meta.cache.set(t.address, t);
      meta.dirty = true;
      const hit = seen.get(t.address);
      if (hit) {
        hit.name = hit.name ?? t.name;
        hit.icon = hit.icon ?? t.icon;
        hit.holders = t.holders;
        if (hit.usdPerToken == null && t.usd != null) hit.usdPerToken = t.usd;
      } else {
        seen.set(t.address, tokenRow(t.address, t, { active: false }));
      }
    }
    meta.save();
  } catch {
    /* explorer unreachable — the chain-derived core is enough */
  }

  // 5. Anything a user imported by address and could trade.
  for (const tok of imported) {
    if (seen.has(tok)) continue;
    const m = meta.get(tok);
    if (m && !m.miss) seen.set(tok, tokenRow(tok, m, { active: activity.has(tok) }));
  }

  // Routability: certain from pool evidence, otherwise from the route cache.
  // Tiers tell the terminal which quote asset actually has a pool.
  for (const t of seen.values()) {
    t.swaps24h = activity.get(t.address) ?? 0;
    t.tradable = moneyPaired.has(t.address) ? true : routable(t.address);
    const r = routes.get(t.address);
    if (r && !r.miss) t.tiers = { eth: r.weth, usdg: r.usdg };
  }

  // Mark stale rather than drop: the next caller gets the current list at
  // once and the rebuild happens behind it.
  const rebuild = () => { if (tokenCache) tokenCache.at = 0; };
  if (pools.pending) pools.onDrained = rebuild;
  if (meta.pending) meta.onDrained = rebuild;
  if (routes.pending) routes.onDrained = rebuild;

  return [...seen.values()]
    .filter((t) => t.tradable !== false || t.active)
    .sort((a, b) => {
      const rank = (t) =>
        t.address === WETH ? 0 : t.address === USDG ? 1 : t.active ? 2 : t.tradable && t.usdPerToken ? 3 : t.tradable ? 4 : 5;
      return rank(a) - rank(b) || b.swaps24h - a.swaps24h || (b.holders ?? 0) - (a.holders ?? 0) || a.symbol.localeCompare(b.symbol);
    });
}

/**
 * Import any token by address: describe it and check it is reachable. This is
 * how the long tail past the list becomes tradable — paste the contract.
 */
export async function tradeToken(store, address) {
  const a = String(address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("bad address");
  const list = await tradeTokens(store);
  const listed = list.find((t) => t.address === a);
  if (listed && listed.tradable != null) return listed;
  const [m, r] = await Promise.all([meta.fetch(a), routes.fetch(a)]);
  if (m.miss) throw new Error("not an ERC-20 we can describe");
  const tradable = money.has(a) || (r && !r.miss && r.weth.length + r.usdg.length > 0);
  if (tradable && !imported.has(a)) {
    imported.add(a);
    saveJson(IMPORTED_FILE, [...imported]);
    if (tokenCache) tokenCache.at = 0;
  }
  return tokenRow(a, m, { active: Boolean(listed?.active), tradable, swaps24h: listed?.swaps24h ?? 0, tiers: r && !r.miss ? { weth: r.weth, usdg: r.usdg } : null });
}

// ---------------------------------------------------------------------------
// Markets: every routable pair that traded today, ranked by volume
// ---------------------------------------------------------------------------
//
// Built from the recorder's tape and the pool cache only — no RPC on the
// request path — so it is cheap enough to poll. Price orientation puts money
// on the quote side (USDG over ETH over anything else), matching the chart.

const moneyRank = (a) => (a === USDG ? 3 : a === WETH ? 2 : 1);
let marketsCache = null; // { at, data }

export async function tradeMarkets(store) {
  if (marketsCache && Date.now() - marketsCache.at < 20_000) return marketsCache.data;
  const now = Math.floor(Date.now() / 1000);
  const day = store?.marketStats?.(now - 86_400) ?? [];
  const hour = new Map((store?.marketStats?.(now - 3_600) ?? []).map((r) => [r.pool, r]));
  const tokens = await tradeTokens(store);
  const tokenByAddr = new Map(tokens.map((t) => [t.address, t]));
  const describe = (a) => {
    const t = tokenByAddr.get(a);
    if (t) return t;
    const m = meta.get(a);
    if (m && !m.miss) return tokenRow(a, m);
    meta.enqueue(a);
    return null;
  };

  const rows = [];
  let unknownPools = 0;
  const described = describePools(store, day.map((r) => r.pool));
  for (const r of day) {
    const p = described.get(r.pool.toLowerCase());
    if (p === undefined) { unknownPools++; continue; } // still being resolved
    if (p === null) continue; // not a factory pool → the router cannot reach it
    const base0 = moneyRank(p.token0) <= moneyRank(p.token1);
    const baseA = base0 ? p.token0 : p.token1;
    const quoteA = base0 ? p.token1 : p.token0;
    const base = describe(baseA);
    const quote = describe(quoteA);
    if (!base || !quote) continue;
    const scale = 10 ** (base.decimals - quote.decimals);
    const orient = (x) => (base0 ? x : x === 0 ? 0 : 1 / x) * scale;
    const price = orient(r.close);
    if (!Number.isFinite(price) || price <= 0) continue;
    const open24 = orient(r.open);
    const h = hour.get(r.pool);
    const open1h = h ? orient(h.open) : null;
    const volQuote = (base0 ? r.vol1 : r.vol0) / 10 ** quote.decimals;
    const quoteUsd = quote.usdPerToken ?? (quoteA === USDG ? 1 : null);
    rows.push({
      pool: p.pool,
      kind: p.kind,
      fee: p.fee,
      ...(p.kind === "v4" ? { tickSpacing: p.tickSpacing, hooks: p.hooks, dynamicFee: p.dynamicFee, native0: p.native0 } : {}),
      base: { address: baseA === WETH ? NATIVE : baseA, symbol: baseA === WETH ? "ETH" : base.symbol, icon: base.icon ?? null, decimals: base.decimals, usdPerToken: base.usdPerToken ?? null },
      quote: { address: quoteA === WETH ? NATIVE : quoteA, symbol: quoteA === WETH ? "ETH" : quote.symbol, decimals: quote.decimals, usdPerToken: quoteUsd },
      price,
      change24: open24 > 0 ? price / open24 - 1 : null,
      change1h: open1h ? price / open1h - 1 : null,
      high24: base0 ? orient(r.high) : orient(r.low),
      low24: base0 ? orient(r.low) : orient(r.high),
      volumeQuote: volQuote,
      volumeUsd: quoteUsd ? volQuote * quoteUsd : null,
      swaps: r.swaps,
      lastTrade: r.lastBucket,
    });
  }

  // One row per pair and venue: the busiest fee tier speaks for it. V3 and V4
  // stay separate rows — the terminal routes V3 only, and the pools page
  // shows a token's V4 market beside its V3 one rather than instead of it.
  const byPair = new Map();
  for (const m of rows) {
    const k = `${m.kind}:${m.base.address}:${m.quote.address}`;
    const cur = byPair.get(k);
    if (!cur || m.swaps > cur.swaps) byPair.set(k, m);
  }
  const markets = [...byPair.values()]
    .sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0) || b.swaps - a.swaps)
    .slice(0, 1600);
  const data = {
    markets,
    pairsTotal: byPair.size,
    v4Pools: store?.v4PoolCount?.() ?? 0,
    coverage: { poolsTraded: day.length, poolsUnknown: unknownPools, tapeSince: day.length ? Math.min(...day.map((r) => r.firstBucket)) : null },
    resolvers: resolverStats(),
    at: new Date().toISOString(),
  };
  marketsCache = { at: Date.now(), data };
  return data;
}

/** Warm the caches at boot so the first visitor never waits on a cold lookup. */
/** Shared with the pools module so both see one cache of pool metadata. */
export const poolCache = pools;

export function warmTradeCaches(store) {
  for (const { pool } of activePoolList(store).slice(0, 600)) if (!isV4PoolId(pool)) pools.enqueue(pool);
  return tradeTokens(store);
}

// ---------------------------------------------------------------------------
// Quotes: best route across direct and one-intermediate V3 paths
// ---------------------------------------------------------------------------

function encodePath(tokens, fees) {
  const types = [];
  const values = [];
  tokens.forEach((t, i) => {
    types.push("address");
    values.push(t);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  });
  return encodePacked(types, values);
}

export async function quotePath(tokens, fees, amountIn) {
  const path = encodePath(tokens, fees);
  try {
    const [amountOut, , , gasEstimate] = await call(QUOTER_V2, QUOTER_ABI, "quoteExactInput", [path, amountIn]);
    return { tokens, fees, path, amountOut, gasEstimate };
  } catch {
    return null; // pool missing or no liquidity along this path
  }
}

/**
 * amountIn is raw units of tokenIn. "eth" means native ETH (wrapped by the
 * router); the path itself always speaks WETH.
 */
export async function tradeQuote({ tokenIn, tokenOut, amountIn, slippageBps = 50, from = null }) {
  const nativeIn = tokenIn === NATIVE;
  const nativeOut = tokenOut === NATIVE;
  const tin = (nativeIn ? WETH : tokenIn).toLowerCase();
  const tout = (nativeOut ? WETH : tokenOut).toLowerCase();
  if (tin === tout) throw new Error("tokenIn and tokenOut are the same asset");
  const amt = BigInt(amountIn);
  if (amt <= 0n) throw new Error("amountIn must be positive");

  const candidates = [];
  for (const fee of FEES) candidates.push(quotePath([tin, tout], [fee], amt));
  for (const mid of [WETH, USDG]) {
    if (mid === tin || mid === tout) continue;
    for (const f1 of [500, 3000, 10000]) {
      for (const f2 of [500, 3000, 10000]) {
        candidates.push(quotePath([tin, mid, tout], [f1, f2], amt));
      }
    }
  }
  const routes = (await Promise.all(candidates)).filter(Boolean);
  if (routes.length === 0) throw new Error("no route with liquidity for this pair");
  routes.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  const best = routes[0];

  // Execution price vs. the same route quoted for a sliver of the size: the
  // difference is what the trade itself moves the pool, i.e. price impact.
  let priceImpactBps = null;
  const sliver = amt / 1000n;
  if (sliver > 0n) {
    const ref = await quotePath(best.tokens, best.fees, sliver);
    if (ref && ref.amountOut > 0n) {
      const unitBest = Number(best.amountOut) / Number(amt);
      const unitRef = Number(ref.amountOut) / Number(sliver);
      if (unitRef > 0) priceImpactBps = Math.max(0, Math.round((1 - unitBest / unitRef) * 10_000));
    }
  }

  const minOut = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Proceeds always go to msg.sender: token output straight from the swap,
  // native output via the router's unwrapWETH9(amountMinimum).
  const data = encodeExactInputSwap({ path: best.path, amountIn: amt, amountOutMinimum: minOut, nativeOut, deadline });

  // Balances and allowance only when the caller says who is asking.
  let account = null;
  if (from && /^0x[0-9a-fA-F]{40}$/.test(from)) {
    if (nativeIn) {
      const bal = BigInt(await rpcFetch("eth_getBalance", [from, "latest"]));
      account = { balance: bal.toString(), allowance: null, needsApproval: false, sufficient: bal >= amt };
    } else {
      const [bal, allowance] = await Promise.all([
        call(tin, ERC20_ABI, "balanceOf", [from]),
        call(tin, ERC20_ABI, "allowance", [from, ROUTER]),
      ]);
      account = {
        balance: bal.toString(),
        allowance: allowance.toString(),
        needsApproval: allowance < amt,
        sufficient: bal >= amt,
      };
    }
  }

  // The transaction is only handed out once it has been executed from the
  // trader's own address and the trader provably ends up with the output.
  // No wallet, no proof, no tx — an unverified swap is not offered to anyone.
  const tx = { to: ROUTER, data, value: nativeIn ? "0x" + amt.toString(16) : "0x0" };
  let guard;
  if (!account) {
    guard = { ok: false, reason: "connect a wallet: the transaction is built and verified for your address" };
  } else if (!account.sufficient) {
    guard = { ok: false, reason: "insufficient balance" };
  } else {
    const proof = await proveDelivery({
      from,
      tx: { to: ROUTER, data, value: nativeIn ? amt : 0n },
      approval: account.needsApproval ? { token: tin, spender: ROUTER, amount: amt } : null,
      expect: [{ asset: nativeOut ? "eth" : tout, min: minOut }],
      pay: [{ asset: nativeIn ? "eth" : tin, max: amt }],
      mustNotRetain: [{ holder: ROUTER, asset: nativeOut ? "eth" : tout }, { holder: ROUTER, asset: WETH }],
    });
    guard = proofToJson(proof);
    if (!proof.ok) {
      console.error(`trade | REFUSED ${from} ${amt} ${nativeIn ? "ETH" : tin} -> ${nativeOut ? "ETH" : tout}: ${proof.reason}`);
    }
  }

  const [infoIn, infoOut] = await Promise.all([getTokenInfo(tin), getTokenInfo(tout)]);
  return {
    amountIn: amt.toString(),
    amountOut: best.amountOut.toString(),
    minOut: minOut.toString(),
    route: { tokens: best.tokens, fees: best.fees, hops: best.fees.length },
    priceImpactBps,
    gasEstimate: best.gasEstimate.toString(),
    tokenIn: { address: nativeIn ? NATIVE : tin, symbol: nativeIn ? "ETH" : infoIn.symbol, decimals: infoIn.decimals },
    tokenOut: { address: nativeOut ? NATIVE : tout, symbol: nativeOut ? "ETH" : infoOut.symbol, decimals: infoOut.decimals },
    for: account ? from : null,
    guard,
    tx: guard.ok ? tx : null,
    approval: account?.needsApproval
      ? {
          token: tin,
          spender: ROUTER,
          data: encodeFunctionData({
            abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
            functionName: "approve",
            args: [ROUTER, amt],
          }),
        }
      : null,
    account,
    quotedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Candles from the pool's own Swap events
// ---------------------------------------------------------------------------

const V3_SWAP_TOPIC = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
const poolAddrCache = new Map(); // "base:quote" -> { at, pool, base0 }
const candleCache = new Map(); // pool -> { at, data }

/** The deepest direct V3 pool for a pair, by current in-range liquidity. */
export async function bestPool(base, quote) {
  const key = `${base}:${quote}`;
  const hit = poolAddrCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit;

  // The pool cache already knows every pool that traded recently; only ask
  // the factory for pairs it has never seen, and ask all tiers at once.
  const b = base.toLowerCase(), q = quote.toLowerCase();
  let found = [];
  for (const p of pools.cache.values()) {
    if (p.miss || !p.v3) continue;
    if ((p.token0 === b && p.token1 === q) || (p.token0 === q && p.token1 === b)) found.push({ pool: p.pool, fee: p.fee });
  }
  if (found.length === 0) {
    found = (
      await Promise.all(
        FEES.map(async (fee) => {
          try {
            const p = (await call(V3_FACTORY, FACTORY_ABI, "getPool", [base, quote, fee])).toLowerCase();
            return p !== "0x0000000000000000000000000000000000000000" ? { pool: p, fee } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);
  }
  if (found.length === 0) return null;
  const withLiq = await Promise.all(
    found.map(async (p) => {
      try {
        return { ...p, liq: await call(p.pool, POOL_ABI, "liquidity") };
      } catch {
        return { ...p, liq: 0n };
      }
    }),
  );
  withLiq.sort((a, b) => (a.liq > b.liq ? -1 : 1));
  const chosen = withLiq[0];
  const token0 = (await call(chosen.pool, POOL_ABI, "token0")).toLowerCase();
  const out = { at: Date.now(), pool: chosen.pool, kind: "v3", fee: chosen.fee, base0: token0 === base.toLowerCase() };
  poolAddrCache.set(key, out);
  return out;
}

/**
 * A V4 pool by its id, in the shape `bestPool` returns, for a pair the caller
 * already knows. The key is what the watcher recorded from Initialize; native
 * ETH in it is WETH to every reader here.
 */
export function v4PoolFor(store, poolId, base, quote) {
  const p = store?.v4Pool?.(poolId.toLowerCase());
  if (!p) return null;
  const c0 = p.currency0 === V4.nativeCurrency ? WETH : p.currency0, c1 = p.currency1;
  if (!((c0 === base && c1 === quote) || (c1 === base && c0 === quote))) return null;
  return { at: Date.now(), pool: p.poolId, kind: "v4", fee: p.fee === V4.dynamicFeeFlag ? null : p.fee, tickSpacing: p.tickSpacing, base0: c0 === base };
}

/** The deepest V4 ETH pool without a hook for a pair, by live liquidity — the V4 stand-in for `bestPool`. */
export async function bestPoolV4(store, base, quote) {
  const rows = store?.v4PoolsForPair?.(base === WETH ? V4.nativeCurrency : base, quote === WETH ? V4.nativeCurrency : quote) ?? [];
  const plain = rows.filter((p) => p.hooks === V4.nativeCurrency && p.fee !== V4.dynamicFeeFlag);
  if (!plain.length) return null;
  const liq = await Promise.all(plain.map((p) => call(V4.stateView, STATE_VIEW_LIQ_ABI, "getLiquidity", [p.poolId]).catch(() => 0n)));
  let best = 0;
  liq.forEach((l, i) => { if (l > liq[best]) best = i; });
  return v4PoolFor(store, plain[best].poolId, base, quote);
}
const STATE_VIEW_LIQ_ABI = [{ type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] }];

/**
 * OHLC of base priced in quote, bucketed by minutes, over the last `spanBlocks`
 * blocks (0.1s blocks: 60_000 ≈ 100 minutes). Price is read off each swap's
 * sqrtPriceX96, so the series is the pool's actual tape, not an oracle.
 *
 * The tape the watcher records into the store is the preferred source — it
 * has no result caps and no upstream to appease. But it only reaches back to
 * the watcher's last restart, so while it is shallow the eth_getLogs walk
 * backfills the older minutes; the walk is also the sole source for pools the
 * recorder has not seen yet.
 */
export async function tradeCandles({ base, quote, pool = null, bucketSec = 60, spanBlocks = 72_000, hours = null, store = null }) {
  const b = (base === NATIVE ? WETH : base).toLowerCase();
  const q = (quote === NATIVE ? WETH : quote).toLowerCase();
  // A caller naming a V4 pool gets that pool's own tape; otherwise the deepest V3 pool for the pair.
  const found = pool && isV4PoolId(pool) ? v4PoolFor(store, pool, b, q) : await bestPool(b, q);
  if (!found) throw new Error(pool ? "unknown V4 pool" : "no direct V3 pool for this pair");

  const [infoBase, infoQuote] = await Promise.all([getTokenInfo(b), getTokenInfo(q)]);
  const now = Math.floor(Date.now() / 1000);
  const rangeSec = hours ? hours * 3600 : spanBlocks * 0.1;
  const fromBucket = Math.floor((now - rangeSec) / bucketSec) * bucketSec;
  const scale = 10 ** (infoBase.decimals - infoQuote.decimals);
  const orient = (p) => (found.base0 ? p : p === 0 ? 0 : 1 / p) * scale;

  // Below a minute there are no stored candles; the rolling trades tape is
  // folded on the fly. It only reaches back a couple of hours, which is all
  // a 5s or 30s chart can sensibly show anyway.
  if (bucketSec < 60) {
    const rows = store?.tradesSince?.(found.pool, fromBucket) ?? [];
    const buckets = new Map();
    for (const r of rows) {
      const sqrt = Number(BigInt(r.sqrtPrice));
      const price = orient((sqrt / 2 ** 96) ** 2);
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = Math.floor(r.ts / bucketSec) * bucketSec;
      const c = buckets.get(t) ?? { time: t, open: price, high: price, low: price, close: price, swaps: 0, vol: 0 };
      c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.swaps++;
      const qAmt = BigInt(found.base0 ? r.amount1 : r.amount0);
      c.vol += Math.abs(toWhole(qAmt < 0n ? -qAmt : qAmt, infoQuote.decimals));
      buckets.set(t, c);
    }
    const candles = [...buckets.values()].sort((a, c) => a.time - c.time);
    return {
      pool: found.pool, kind: found.kind ?? "v3", fee: found.fee,
      base: { address: b, symbol: infoBase.symbol }, quote: { address: q, symbol: infoQuote.symbol },
      bucketSec, spanBlocks, source: "tape", truncated: false, coverage: null, backfill: null,
      swaps: rows.length, volumeQuote: candles.reduce((n, c) => n + c.vol, 0),
      last: candles.length ? candles[candles.length - 1].close : null, candles,
    };
  }

  // Minute candles are what the tape stores; anything coarser is rolled up
  // in SQL so a month of hourly candles is a few hundred rows, not 40k.
  const recorded =
    bucketSec > 60 && store?.candlesAgg
      ? store.candlesAgg(found.pool, fromBucket, now, bucketSec)
      : store?.candlesFor?.(found.pool, fromBucket) ?? [];
  const coverage = store?.candleCoverage?.(found.pool) ?? null;
  // Where the history backfill has reached for this pool, so the chart can say
  // "history is still being loaded" instead of looking like the market began
  // yesterday. The checkpoint is the lowest block already walked.
  const bfBlock = Number(store?.getMeta?.(`backfill:${found.pool}`) ?? NaN);
  const backfill = Number.isFinite(bfBlock) ? { reachedBlock: bfBlock, done: bfBlock <= 0 } : null;
  // Inverting swaps the extremes: yesterday's high is today's low.
  const recCandles = recorded.map((c) => ({
    time: c.bucket,
    open: orient(c.open),
    high: found.base0 ? orient(c.high) : orient(c.low),
    low: found.base0 ? orient(c.low) : orient(c.high),
    close: orient(c.close),
    swaps: c.swaps,
    vol: (found.base0 ? c.vol1 : c.vol0) / 10 ** infoQuote.decimals,
  }));

  // A pool the recorder has barely seen gets the eth_getLogs backfill for
  // whatever the upstreams will still serve; a pool with real tape depth
  // (backfilled or simply old) is served from the tape alone.
  const DEEP_ENOUGH = 60;
  let candles = recCandles;
  let truncated = false;
  let source = "recorder";
  if (recCandles.length < DEEP_ENOUGH && bucketSec === 60) {
    try {
      const cutoff = recCandles.length ? recCandles[0].time : Infinity;
      const walked = await candlesFromLogs(found, infoBase, infoQuote, bucketSec, spanBlocks, cutoff);
      const older = walked.candles.filter((c) => c.time < cutoff);
      candles = [...older, ...recCandles];
      truncated = walked.truncated;
      source = recCandles.length ? "recorder+logs" : "logs";
    } catch (e) {
      if (recCandles.length === 0) throw e; // nothing at all to show
    }
  }

  return {
    pool: found.pool,
    kind: found.kind ?? "v3",
    fee: found.fee,
    base: { address: b, symbol: infoBase.symbol },
    quote: { address: q, symbol: infoQuote.symbol },
    bucketSec,
    spanBlocks,
    hours: hours ?? Math.round(rangeSec / 3600),
    coverage,
    backfill,
    source,
    truncated,
    swaps: candles.reduce((n, c) => n + (c.swaps ?? 0), 0),
    volumeQuote: candles.reduce((n, c) => n + (c.vol ?? 0), 0),
    last: candles.length ? candles[candles.length - 1].close : null,
    candles,
  };
}

/** The eth_getLogs walk, cached briefly per pool so chart polls don't hammer upstreams. */
async function candlesFromLogs(found, infoB, infoQ, bucketSec, spanBlocks, beforeTime = Infinity) {
  const cacheKey = `${found.pool}:${bucketSec}:${spanBlocks}`;
  const hit = candleCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 45_000) return hit.data;

  const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
  const floor = Math.max(0, head - spanBlocks);
  // Newest-first with an adaptive window: the busiest pools do >10k swaps in
  // 20k blocks (0.1s each), which is precisely the result cap public
  // endpoints enforce. Walking backwards means running out of call budget
  // costs old history, never the candles the trader is looking at.
  const logs = [];
  let hi = head;
  if (Number.isFinite(beforeTime)) {
    // The recorder already owns everything from beforeTime onward; skip the
    // overlap so the call budget is spent purely on older history.
    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - beforeTime);
    hi = Math.min(hi, head - ageSec * 10); // 0.1s blocks
  }
  let span = 100; // upstreams call anything older than ~128 blocks an archive request
  let budget = 12;
  let truncated = false;
  while (hi >= floor && budget > 0) {
    const lo = Math.max(floor, hi - span + 1);
    budget--;
    try {
      // A V4 pool's swaps are the singleton's, filtered by the PoolId topic; the
      // data words that matter (amounts, then sqrtPriceX96) sit where V3 puts them.
      const part = await rpcFetch("eth_getLogs", [
        found.kind === "v4"
          ? { address: V4.poolManager, topics: [V4.swapTopic, found.pool], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) }
          : { address: found.pool, topics: [V3_SWAP_TOPIC], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) },
      ]);
      logs.push(...part);
      hi = lo - 1;
      if (part.length < 3000 && span < 400) span *= 2;
    } catch (e) {
      if (span > 250) {
        span = Math.floor(span / 2);
        continue;
      }
      break; // even a sliver is refused — keep what we have
    }
  }
  if (hi >= floor) truncated = true;

  // sqrtPriceX96 is token1-per-token0; orient it to quote-per-base and fix
  // the decimal scale so the chart shows human prices.
  const scale = 10 ** (infoB.decimals - infoQ.decimals);
  const priceOf = (sqrtHex) => {
    const sqrt = Number(BigInt(sqrtHex));
    const p = (sqrt / 2 ** 96) ** 2; // token1 per token0, raw units
    const oriented = found.base0 ? p : p === 0 ? 0 : 1 / p;
    return oriented * scale;
  };

  // Swap event data: (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  const buckets = new Map();
  // 0.1s blocks make block-number time good enough for bucketing.
  const blockToTime = (bn) => Math.floor(Date.now() / 1000) - Math.round((head - bn) * 0.1);
  for (const l of logs) {
    const data = l.data.slice(2);
    if (data.length < 5 * 64) continue;
    const sqrtHex = "0x" + data.slice(2 * 64, 3 * 64);
    const price = priceOf(sqrtHex);
    if (!Number.isFinite(price) || price <= 0) continue;
    const t = blockToTime(Number(BigInt(l.blockNumber)));
    const bucket = Math.floor(t / bucketSec) * bucketSec;
    const c =
      buckets.get(bucket) ??
      { time: bucket, open: price, high: price, low: price, close: price, swaps: 0, vol: 0 };
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.swaps++;
    // Quote-side volume: |amountQuote| of each swap.
    const raw = BigInt("0x" + (found.base0 ? data.slice(64, 128) : data.slice(0, 64)));
    const signed = raw > 2n ** 255n ? raw - 2n ** 256n : raw;
    c.vol += Math.abs(toWhole(signed < 0n ? -signed : signed, infoQ.decimals));
    buckets.set(bucket, c);
  }

  const candles = [...buckets.values()].sort((a, c) => a.time - c.time);
  const data = { candles, truncated };
  candleCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Pair stats: what the instrument bar shows
// ---------------------------------------------------------------------------

const int256 = (word) => {
  const v = BigInt("0x" + word);
  return v >= 2n ** 255n ? v - 2n ** 256n : v;
};

const pairCache = new Map(); // pool -> { at, data }

export async function tradePair({ base, quote }) {
  const b = (base === NATIVE ? WETH : base).toLowerCase();
  const q = (quote === NATIVE ? WETH : quote).toLowerCase();
  const found = await bestPool(b, q);
  if (!found) throw new Error("no direct V3 pool for this pair");

  const hit = pairCache.get(found.pool);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;

  const [infoB, infoQ, balB, balQ] = await Promise.all([
    getTokenInfo(b),
    getTokenInfo(q),
    call(b, ERC20_ABI, "balanceOf", [found.pool]),
    call(q, ERC20_ABI, "balanceOf", [found.pool]),
  ]);
  const wholeB = toWhole(balB, infoB.decimals);
  const wholeQ = toWhole(balQ, infoQ.decimals);
  const tvlUsd =
    (infoB.usdPerToken ? wholeB * infoB.usdPerToken : 0) +
    (infoQ.usdPerToken ? wholeQ * infoQ.usdPerToken : 0);

  const data = {
    pool: found.pool,
    fee: found.fee,
    tvlUsd,
    reserves: { base: wholeB, quote: wholeQ },
    base: { address: b, symbol: infoB.symbol, usdPerToken: infoB.usdPerToken },
    quote: { address: q, symbol: infoQ.symbol, usdPerToken: infoQ.usdPerToken },
  };
  pairCache.set(found.pool, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Trades tape: the pool's most recent individual swaps
// ---------------------------------------------------------------------------

const tradesCache = new Map(); // pool -> { at, data }

export async function tradeTrades({ base, quote, limit = 40, store = null }) {
  const b = (base === NATIVE ? WETH : base).toLowerCase();
  const q = (quote === NATIVE ? WETH : quote).toLowerCase();
  const found = await bestPool(b, q);
  if (!found) throw new Error("no direct V3 pool for this pair");

  const hit = tradesCache.get(found.pool);
  if (hit && Date.now() - hit.at < 3_000) return hit.data;

  const [infoB, infoQ] = await Promise.all([getTokenInfo(b), getTokenInfo(q)]);
  const scale = 10 ** (infoB.decimals - infoQ.decimals);
  const row = ({ block, logIndex, txHash, amount0, amount1, sqrtPrice, ts }) => {
    const p = (Number(BigInt(sqrtPrice)) / 2 ** 96) ** 2;
    const price = (found.base0 ? p : p === 0 ? 0 : 1 / p) * scale;
    if (!Number.isFinite(price) || price <= 0) return null;
    const a0 = BigInt(amount0), a1 = BigInt(amount1);
    const amtBase = found.base0 ? a0 : a1;
    const amtQuote = found.base0 ? a1 : a0;
    return {
      block, time: ts, tx: txHash, logIndex, price,
      sizeBase: Math.abs(toWhole(amtBase < 0n ? -amtBase : amtBase, infoB.decimals)),
      sizeQuote: Math.abs(toWhole(amtQuote < 0n ? -amtQuote : amtQuote, infoQ.decimals)),
      // Positive base delta means the pool received base: someone sold it.
      side: amtBase > 0n ? "sell" : "buy",
    };
  };

  // The recorder's tape first: exact, deep, and free of upstream limits.
  let rows = (store?.recentTrades?.(found.pool, limit) ?? []).map(row).filter(Boolean);
  let source = "recorder";

  // Fallback for a pool the recorder has not written yet: the head of the
  // chain via eth_getLogs, in the ~100-block window every upstream still
  // serves without calling it an archive request.
  if (rows.length === 0) {
    source = "logs";
    try {
      const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
      const now = Math.floor(Date.now() / 1000);
      const logs = await rpcFetch("eth_getLogs", [
        { address: found.pool, topics: [V3_SWAP_TOPIC], fromBlock: "0x" + Math.max(0, head - 100).toString(16), toBlock: "0x" + head.toString(16) },
      ]);
      rows = logs
        .map((l) => {
          const data = l.data.slice(2);
          if (data.length < 5 * 64) return null;
          const block = Number(BigInt(l.blockNumber));
          return row({
            block, logIndex: Number(BigInt(l.logIndex ?? "0x0")), txHash: l.transactionHash,
            amount0: int256(data.slice(0, 64)).toString(), amount1: int256(data.slice(64, 128)).toString(),
            sqrtPrice: BigInt("0x" + data.slice(128, 192)).toString(), ts: now - Math.round((head - block) * 0.1),
          });
        })
        .filter(Boolean);
    } catch {
      /* nothing recent to show */
    }
  }
  rows.sort((x, y) => y.block - x.block || y.logIndex - x.logIndex);

  const data = {
    pool: found.pool,
    base: { address: b, symbol: infoB.symbol },
    quote: { address: q, symbol: infoQ.symbol },
    source,
    trades: rows.slice(0, limit),
  };
  tradesCache.set(found.pool, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Wallet balances across every listed token
// ---------------------------------------------------------------------------

const balancesCache = new Map(); // address -> { at, data }

export async function tradeBalances(store, address) {
  const a = String(address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("bad address");
  const hit = balancesCache.get(a);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;

  const list = await tradeTokens(store);
  const rows = [];
  const weth = list.find((t) => t.address === WETH);
  try {
    const eth = BigInt(await rpcFetch("eth_getBalance", [a, "latest"]));
    if (eth > 0n) {
      const amount = toWhole(eth, 18);
      rows.push({ symbol: "ETH", address: NATIVE, amount, usd: weth?.usdPerToken ? amount * weth.usdPerToken : null });
    }
  } catch { /* show what we can */ }

  let i = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (i < list.length) {
        const t = list[i++];
        try {
          const bal = await call(t.address, ERC20_ABI, "balanceOf", [a]);
          if (bal > 0n) {
            const amount = toWhole(bal, t.decimals);
            rows.push({ symbol: t.symbol, address: t.address, amount, usd: t.usdPerToken ? amount * t.usdPerToken : null });
          }
        } catch { /* token contract said no — skip */ }
      }
    }),
  );
  rows.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));

  const data = { address: a, tokens: rows, at: new Date().toISOString() };
  balancesCache.set(a, { at: Date.now(), data });
  return data;
}
