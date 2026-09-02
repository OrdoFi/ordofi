import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbiItem, toEventSelector } from "viem";
import { rpcFetch, rpcOnce, rpcUrls, RPC_HEADERS } from "@ordofi/core";
import { ethUsd } from "@ordofi/core/pricing";
import {
  alignTick,
  allocateRungs,
  amountsForLiquidity,
  planLadder,
  priceToTick,
  splitLadder,
  tickToPrice,
  tickToSqrtPriceX96,
} from "@ordofi/core/liquidity";
import { CHAIN, USDG, WETH, bestPool, poolCache, tradeCandles, tradeMarkets, tradeTokens } from "./trade.mjs";

/**
 * Liquidity provision on Uniswap V3 pools, the way a person would want to do
 * it: pick a token, see where liquidity sits, drag a range, choose a shape,
 * and mint the whole ladder in one transaction through OrdoLadderManager.
 *
 * This module is the read side and the planner. It never signs anything; it
 * turns "I want a curve from $2,300 to $2,600 with 1 ETH" into the exact rungs
 * the contract will mint, and it reads back what a wallet already holds.
 */

/** v3: the v2 manager plus EIP-2612 permit entry points. */
export const LADDER_MANAGER = process.env.ORDO_LADDER_ADDRESS ?? "0xf9b15283AcbDd693d39d23AccDA7213d8d46a9E2";
/** Block the manager was deployed in; event scans never look further back. */
const LADDER_DEPLOY_BLOCK = Number(process.env.ORDO_LADDER_BLOCK ?? 52_895_364);
const NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const NATIVE = "eth";
export const SHAPES = ["spot", "curve", "bidask"];
const shapeCode = (s) => Math.max(0, SHAPES.indexOf(s));

const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "tickBitmap", stateMutability: "view", inputs: [{ type: "int16" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ticks", stateMutability: "view", inputs: [{ type: "int24" }], outputs: [{ type: "uint128" }, { type: "int128" }, { type: "uint256" }, { type: "uint256" }, { type: "int56" }, { type: "uint160" }, { type: "uint32" }, { type: "bool" }] },
];
const ERC20_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const PERMIT_TUPLE = { name: "permit", type: "tuple", components: [
  { name: "token", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" },
  { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
] };
const RUNG_TUPLE = { name: "rungs", type: "tuple[]", components: [
  { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
  { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" },
  { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
] };
export const LADDER_ABI = [
  {
    type: "function", name: "openLadder", stateMutability: "payable",
    inputs: [{ name: "pool", type: "address" }, RUNG_TUPLE, { name: "shape", type: "uint8" }, { name: "minTick", type: "int24" }, { name: "maxTick", type: "int24" }, { name: "deadline", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "addLiquidity", stateMutability: "payable",
    inputs: [{ name: "ladderId", type: "uint256" }, RUNG_TUPLE, { name: "deadline", type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function", name: "openLadderWithPermit", stateMutability: "payable",
    inputs: [{ name: "pool", type: "address" }, RUNG_TUPLE, { name: "shape", type: "uint8" }, { name: "minTick", type: "int24" }, { name: "maxTick", type: "int24" }, { name: "deadline", type: "uint256" }, PERMIT_TUPLE],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "addLiquidityWithPermit", stateMutability: "payable",
    inputs: [{ name: "ladderId", type: "uint256" }, RUNG_TUPLE, { name: "deadline", type: "uint256" }, PERMIT_TUPLE],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  { type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "closeBins", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256[]" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "close", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "closeMany", stateMutability: "nonpayable", inputs: [{ type: "uint256[]" }], outputs: [] },
  { type: "function", name: "laddersOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "ladderCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "ladder", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "pool", type: "address" }, { name: "shape", type: "uint8" },
      { name: "openedAt", type: "uint64" }, { name: "closedAt", type: "uint64" }, { name: "openBins", type: "uint32" },
      { name: "deposited0", type: "uint256" }, { name: "deposited1", type: "uint256" },
      { name: "withdrawn0", type: "uint256" }, { name: "withdrawn1", type: "uint256" },
      { name: "collected0", type: "uint256" }, { name: "collected1", type: "uint256" },
      { name: "bins", type: "tuple[]", components: [
        { name: "tokenId", type: "uint256" }, { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }, { name: "open", type: "bool" },
      ] },
    ] }],
  },
  parseAbiItem("event LadderOpened(uint256 indexed ladderId, address indexed owner, address indexed pool, uint8 shape, uint256 bins, uint256 deposited0, uint256 deposited1)"),
  parseAbiItem("event LiquidityAdded(uint256 indexed ladderId, address indexed owner, uint256 added0, uint256 added1, uint256 newBins)"),
  parseAbiItem("event FeesCollected(uint256 indexed ladderId, address indexed owner, uint256 toOwner0, uint256 toOwner1, uint256 toTreasury0, uint256 toTreasury1)"),
  parseAbiItem("event BinsClosed(uint256 indexed ladderId, address indexed owner, uint256 count, uint256 principal0, uint256 principal1, uint256 remaining)"),
  parseAbiItem("event LadderClosed(uint256 indexed ladderId, address indexed owner)"),
];
const NPM_EVENTS = [
  parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)"),
  parseAbiItem("event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)"),
  parseAbiItem("event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)"),
];
const MANAGER_TOPICS = LADDER_ABI.filter((x) => x.type === "event").map((e) => toEventSelector(e));
const NPM_TOPICS = new Map(NPM_EVENTS.map((e) => [toEventSelector(e), e.name]));
const NPM_ABI = [
  {
    type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" },
      { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" },
    ],
  },
];

// ------------------------------------------------------------------ rpc

async function call(to, abi, functionName, args = [], from) {
  const req = { to, data: encodeFunctionData({ abi, functionName, args }) };
  if (from) req.from = from;
  const data = await rpcFetch("eth_call", [req, "latest"]);
  return decodeFunctionResult({ abi, functionName, data });
}

/**
 * Many eth_calls in few HTTP round trips. The upstream counts each call in a
 * batch against its per-second limit, so a busy pool's thousand ticks go over
 * in chunks with a breath between them rather than as one wall.
 */
const BATCH = 120;
async function batchCall(items) {
  if (items.length <= BATCH) return batchOnce(items);
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) {
    if (i) await new Promise((r) => setTimeout(r, 350));
    out.push(...(await batchOnce(items.slice(i, i + BATCH))));
  }
  return out;
}
async function batchOnce(items) {
  if (!items.length) return [];
  const url = rpcUrls()[0];
  const body = items.map((it, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: it.to, data: encodeFunctionData({ abi: it.abi, functionName: it.fn, args: it.args ?? [] }) }, "latest"] }));
  try {
    const r = await fetch(url, { method: "POST", headers: RPC_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error("no batch");
    const byId = new Map(arr.map((x) => [x.id, x]));
    return items.map((it, i) => {
      const res = byId.get(i + 1);
      if (!res || res.error) return null;
      try { return decodeFunctionResult({ abi: it.abi, functionName: it.fn, data: res.result }); } catch { return null; }
    });
  } catch {
    const out = [];
    for (const it of items) out.push(await call(it.to, it.abi, it.fn, it.args ?? []).catch(() => null));
    return out;
  }
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
/**
 * Like `cached`, but once a value exists nobody waits for a refresh: a stale
 * value is served and rebuilt in the background. For the list, whose rebuild
 * is a few hundred reads, this is the difference between a page and a spinner.
 */
const refreshing = new Map();
async function cachedSWR(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  if (hit) {
    if (!refreshing.has(key)) refreshing.set(key, fn().then((v) => cache.set(key, { at: Date.now(), v })).catch(() => {}).finally(() => refreshing.delete(key)));
    return hit.v;
  }
  if (!refreshing.has(key)) refreshing.set(key, fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }).finally(() => refreshing.delete(key)));
  return refreshing.get(key);
}

// ---------------------------------------------------------------- icons

/**
 * Token logos. First the curated map (the same CoinGecko / GeckoTerminal /
 * DexScreener / IPFS images the other LP front ends show), then whatever the
 * indexer already knows, then DexScreener's per-address image — probed once in
 * the background and remembered, so a missing logo never costs a request.
 */
let ICON_SEED = {};
try { ICON_SEED = JSON.parse(readFileSync(new URL("./token-icons.json", import.meta.url), "utf8")); } catch { /* optional */ }
const ICON_CACHE_FILE = join(process.env.ORDO_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../data"), "token-icons-cache.json");
const iconCache = new Map(); // address → { url: string|null, at }
try { for (const [a, v] of Object.entries(JSON.parse(readFileSync(ICON_CACHE_FILE, "utf8")))) iconCache.set(a, v); } catch { /* first run */ }
const NEG_ICON_TTL = 24 * 3_600_000;
const UA = { "user-agent": "Mozilla/5.0 (compatible; OrdoFi)", accept: "application/json, image/*" };
export function iconFor(address) {
  const a = lower(address);
  return ICON_SEED[a] ?? iconCache.get(a)?.url ?? null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Three places a logo can live, cheapest first: DexScreener's per-address
 * image, then the token's DexScreener profile, then GeckoTerminal. The last
 * two are rate-limited APIs, so the probe is paced rather than parallel.
 */
async function probeIcon(a) {
  const dd = `https://dd.dexscreener.com/ds-data/tokens/robinhood/${a}.png?size=lg`;
  try {
    const r = await fetch(dd, { signal: AbortSignal.timeout(6_000), headers: UA });
    const ok = r.ok && (r.headers.get("content-type") ?? "").startsWith("image/");
    try { await r.body?.cancel(); } catch { /* drained */ }
    if (ok) return dd;
  } catch { /* next source */ }
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${a}`, { signal: AbortSignal.timeout(8_000), headers: UA });
    const d = await r.json();
    const u = Array.isArray(d) ? d.find((p) => p?.info?.imageUrl)?.info?.imageUrl : null;
    if (u) return u;
  } catch { /* next source */ }
  try {
    await sleep(2_100); // GeckoTerminal allows ~30 calls a minute
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${a}`, { signal: AbortSignal.timeout(8_000), headers: UA });
    const d = await r.json();
    const u = d?.data?.attributes?.image_url;
    if (u && u !== "missing.png") return u;
  } catch { /* none */ }
  return null;
}
let iconJob = null;
function persistIcons() {
  try { writeFileSync(ICON_CACHE_FILE, JSON.stringify(Object.fromEntries(iconCache))); } catch { /* read-only data dir */ }
}
function scheduleIconProbe(addresses) {
  const now = Date.now();
  const todo = [...new Set(addresses.map(lower))].filter((a) => !ICON_SEED[a] && (!iconCache.has(a) || (iconCache.get(a).url == null && now - iconCache.get(a).at > NEG_ICON_TTL)));
  if (!todo.length || iconJob) return;
  iconJob = (async () => {
    let i = 0, since = 0;
    const worker = async () => {
      while (i < todo.length) {
        const a = todo[i++];
        iconCache.set(a, { url: await probeIcon(a), at: Date.now() });
        if (++since % 10 === 0) { persistIcons(); cache.delete("list"); }
      }
    };
    await Promise.all(Array.from({ length: 2 }, worker));
    persistIcons();
    cache.delete("list"); // the next list carries the new logos
  })().catch(() => {}).finally(() => { iconJob = null; });
}

const lower = (a) => String(a ?? "").toLowerCase();

let STORE = null;
/** The web server hands over its store once at boot; every read here uses it. */
export function setPoolsStore(store) { STORE = store; }
const isMoney = (a) => a === WETH || a === USDG;

// ----------------------------------------------------------------- list

/**
 * The token table: everything with a live V3 market, ranked two ways.
 *   trending    — by 24h volume, the busiest first.
 *   established — by market cap among tokens that actually traded.
 * Fees are volume times the pool's fee tier; that is what LPs split.
 */
export async function poolsList(store) {
  return cachedSWR("list", 30_000, async () => {
    const [markets, tokens] = await Promise.all([tradeMarkets(store), tradeTokens(store)]);
    const tokenBy = new Map(tokens.map((t) => [t.address, t]));
    const byToken = new Map();
    for (const m of markets.markets ?? []) {
      const baseAddr = m.base.address === NATIVE ? WETH : m.base.address;
      if (isMoney(baseAddr)) continue;
      // Fee tier in percent. A V4 hook that sets its own fee reports none;
      // its LP take is unknown here and counted as nothing rather than guessed.
      const feePct = m.fee != null ? m.fee / 1e4 : m.kind === "v4" ? 0 : 0.3;
      const kind = m.kind ?? "v3";
      const cur = byToken.get(baseAddr);
      const row = {
        token: baseAddr,
        symbol: m.base.symbol,
        name: tokenBy.get(baseAddr)?.name ?? null,
        icon: m.base.icon ?? tokenBy.get(baseAddr)?.icon ?? iconFor(baseAddr),
        decimals: m.base.decimals,
        priceUsd: m.base.usdPerToken ?? (m.quote.usdPerToken ? m.price * m.quote.usdPerToken : null),
        change24: m.change24,
        volume24Usd: m.volumeUsd ?? 0,
        fees24Usd: (m.volumeUsd ?? 0) * (feePct / 100),
        trades24: m.swaps,
        pool: m.pool,
        kind,
        quote: m.quote.symbol,
        quotes: [m.quote.symbol],
        venues: [kind],
        pools: 1,
      };
      if (!cur) byToken.set(baseAddr, row);
      else {
        cur.volume24Usd += row.volume24Usd; cur.fees24Usd += row.fees24Usd; cur.trades24 += row.trades24; cur.pools++;
        if (!cur.quotes.includes(row.quote)) cur.quotes.push(row.quote);
        if (!cur.venues.includes(kind)) cur.venues.push(kind);
        if (row.volume24Usd > (cur.mainVol ?? 0)) { cur.pool = row.pool; cur.kind = kind; cur.quote = row.quote; cur.mainVol = row.volume24Usd; }
      }
    }

    // Market cap: total supply × price, cached for an hour per token.
    const rows = [...byToken.values()];
    const supplies = await Promise.all(rows.map((r) => cached(`supply:${r.token}`, 3_600_000, () => call(r.token, ERC20_ABI, "totalSupply").catch(() => null))));
    rows.forEach((r, i) => { r.marketCapUsd = supplies[i] != null && r.priceUsd ? Number(supplies[i]) / 10 ** r.decimals * r.priceUsd : null; });
    // Age: first candle we have for its main pool.
    for (const r of rows) {
      const cov = store?.candleCoverage?.(r.pool);
      r.ageDays = cov ? Math.max(0, Math.floor((Date.now() / 1000 - cov.from) / 86_400)) : null;
    }
    scheduleIconProbe(rows.filter((r) => !r.icon).map((r) => r.token));
    const all = rows.slice().sort((a, b) => b.volume24Usd - a.volume24Usd);
    const trending = all.slice(0, 40);
    const established = rows.filter((r) => r.marketCapUsd).sort((a, b) => b.marketCapUsd - a.marketCapUsd).slice(0, 40);
    const totals = { volume24Usd: rows.reduce((n, r) => n + r.volume24Usd, 0), fees24Usd: rows.reduce((n, r) => n + r.fees24Usd, 0), tokens: rows.length };
    // The header cards: busiest by trades and by volume.
    const mostTraded = rows.slice().sort((a, b) => b.trades24 - a.trades24)[0] ?? null;
    const highestVolume = all[0] ?? null;
    return { trending, established, all, featured: { mostTraded, highestVolume }, totals, manager: LADDER_MANAGER, at: new Date().toISOString() };
  });
}

// ----------------------------------------------------------------- pool

/** Live state of one pool plus its tokens, oriented so `base` is the token being LP'd. */
export async function poolState(pool, baseToken) {
  pool = lower(pool);
  const info = poolCache.get(pool) ?? await new Promise((r) => { poolCache.enqueue(pool); setTimeout(() => r(poolCache.get(pool)), 1500); });
  if (!info || !info.v3) throw new Error("not a Uniswap V3 pool we know");
  const [slot0, liquidity, spacing] = await Promise.all([
    call(pool, POOL_ABI, "slot0"),
    call(pool, POOL_ABI, "liquidity"),
    call(pool, POOL_ABI, "tickSpacing"),
  ]);
  const base = lower(baseToken) === info.token1 ? info.token1 : info.token0;
  const quote = base === info.token0 ? info.token1 : info.token0;
  const [bInfo, qInfo, usd, supply, held] = await Promise.all([
    tokenInfo(base), tokenInfo(quote), ethUsd().catch(() => null),
    // Market cap needs the supply; a null answer is not cached so a throttled
    // upstream cannot blank the MC toggle for an hour.
    cached(`supply:${base}`, 3_600_000, async () => { const s = await call(base, ERC20_ABI, "totalSupply").catch(() => null); if (s == null) cache.delete(`supply:${base}`); return s; }),
    batchCall([{ to: info.token0, abi: ERC20_ABI, fn: "balanceOf", args: [getAddress(pool)] }, { to: info.token1, abi: ERC20_ABI, fn: "balanceOf", args: [getAddress(pool)] }]),
  ]);
  const tick = Number(slot0[1]);
  const raw = tickToPrice(tick); // token1 per token0, raw units
  const scale = 10 ** (bInfo.decimals - qInfo.decimals);
  const price = base === info.token0 ? raw * scale : 1 / (raw * scale); // quote per base, whole units
  const quoteUsd = quote === WETH ? usd : quote === USDG ? 1 : qInfo.usdPerToken;
  const priceUsd = quoteUsd ? price * quoteUsd : null;
  const supplyWhole = supply != null ? Number(supply) / 10 ** bInfo.decimals : null;
  // What the pool holds, in dollars: Delta's "Liquidity" figure.
  const heldBase = held[base === info.token0 ? 0 : 1], heldQuote = held[base === info.token0 ? 1 : 0];
  const tvlUsd = heldBase != null && heldQuote != null && priceUsd != null && quoteUsd != null
    ? (Number(heldBase) / 10 ** bInfo.decimals) * priceUsd + (Number(heldQuote) / 10 ** qInfo.decimals) * quoteUsd : null;
  return {
    pool, fee: info.fee, tickSpacing: Number(spacing), tick, sqrtPriceX96: slot0[0].toString(), liquidity: liquidity.toString(),
    token0: info.token0, token1: info.token1,
    base: { ...bInfo, isToken0: base === info.token0, totalSupply: supplyWhole }, quote: { ...qInfo, usdPerToken: quoteUsd },
    price, priceUsd, marketCapUsd: supplyWhole != null && priceUsd != null ? supplyWhole * priceUsd : null, tvlUsd,
  };
}

async function tokenInfo(address) {
  const t = (await tradeTokens(STORE)).find((x) => x.address === address);
  return { address, symbol: address === WETH ? "ETH" : t?.symbol ?? address.slice(0, 8), name: t?.name ?? null, decimals: t?.decimals ?? 18, icon: t?.icon ?? iconFor(address), usdPerToken: t?.usdPerToken ?? null };
}

/** The token a pool is "about": whichever side is not ETH or USDG. */
async function baseOf(pool) {
  const info = poolCache.get(lower(pool));
  if (!info) return undefined;
  return isMoney(info.token0) && !isMoney(info.token1) ? info.token1 : info.token0;
}

/** Every V3 pool for a token against ETH or USDG, deepest first. */
export async function poolsForToken(token) {
  token = lower(token);
  const all = [...poolCache.cache.entries()];
  const mine = all.filter(([, p]) => p && !p.miss && p.v3 && (p.token0 === token || p.token1 === token) && (isMoney(p.token0) || isMoney(p.token1)));
  const liq = await batchCall(mine.map(([addr]) => ({ to: addr, abi: POOL_ABI, fn: "liquidity" })));
  return mine
    .map(([addr, p], i) => ({ pool: addr, fee: p.fee, quote: p.token0 === token ? p.token1 : p.token0, liquidity: liq[i] != null ? liq[i].toString() : "0" }))
    .map((p) => ({ ...p, quoteSymbol: p.quote === WETH ? "ETH" : "USDG" }))
    .sort((a, b) => (BigInt(b.liquidity) > BigInt(a.liquidity) ? 1 : -1));
}

// ---------------------------------------------------------------- depth

/**
 * Where the liquidity is. Reads the tick bitmap around the price, then the
 * net liquidity at every initialised tick, and walks outward from the current
 * active liquidity to rebuild the depth profile. Bucketed for the chart.
 */
export async function poolDepth(pool, { spanTicks = 3000, buckets = 60 } = {}) {
  pool = lower(pool);
  return cached(`depth:${pool}:${spanTicks}:${buckets}`, 30_000, async () => {
    const st = await poolState(pool);
    const spacing = st.tickSpacing;
    const lo = alignTick(st.tick - spanTicks, spacing, "down");
    const hi = alignTick(st.tick + spanTicks, spacing, "up");
    const wordOf = (t) => Math.floor(Math.floor(t / spacing) / 256);
    const words = [];
    for (let w = wordOf(lo); w <= wordOf(hi); w++) words.push(w);
    const bitmaps = await batchCall(words.map((w) => ({ to: pool, abi: POOL_ABI, fn: "tickBitmap", args: [w] })));
    const initialised = [];
    words.forEach((w, i) => {
      const bm = bitmaps[i];
      if (!bm) return;
      for (let b = 0; b < 256; b++) {
        if ((bm >> BigInt(b)) & 1n) {
          const t = (w * 256 + b) * spacing;
          if (t >= lo && t <= hi) initialised.push(t);
        }
      }
    });
    initialised.sort((a, b) => a - b);
    const nets = await batchCall(initialised.map((t) => ({ to: pool, abi: POOL_ABI, fn: "ticks", args: [t] })));
    const netAt = new Map(initialised.map((t, i) => [t, nets[i] ? BigInt(nets[i][1]) : 0n]));

    // Active liquidity per tick, walking up and down from the current tick.
    const L0 = BigInt(st.liquidity);
    const above = initialised.filter((t) => t > st.tick);
    const below = initialised.filter((t) => t <= st.tick).reverse();
    const segs = []; // [from, to, L]
    let L = L0, from = st.tick;
    for (const t of above) { segs.push([from, t, L]); L += netAt.get(t); from = t; }
    segs.push([from, hi, L]);
    L = L0; let to = st.tick;
    for (const t of below) { segs.push([t, to, L]); L -= netAt.get(t); to = t; }
    segs.push([lo, to, L]);

    // Bucket into bars with the token amounts that liquidity represents.
    const width = (hi - lo) / buckets;
    const bars = [];
    for (let i = 0; i < buckets; i++) {
      const a = lo + i * width, b = a + width;
      let liq = 0n, n = 0;
      for (const [f, t, l] of segs) { const ov = Math.min(b, t) - Math.max(a, f); if (ov > 0) { liq += l * BigInt(Math.round(ov)); n += Math.round(ov); } }
      const avg = n ? liq / BigInt(n) : 0n;
      const amts = amountsForLiquidity(tickToSqrtPriceX96(st.tick), tickToSqrtPriceX96(Math.round(a)), tickToSqrtPriceX96(Math.round(b)), avg);
      const scale0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals);
      const scale1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
      const p0Usd = st.base.isToken0 ? st.priceUsd : st.quote.usdPerToken;
      const p1Usd = st.base.isToken0 ? st.quote.usdPerToken : st.priceUsd;
      const usd = (Number(amts.amount0) / scale0) * (p0Usd ?? 0) + (Number(amts.amount1) / scale1) * (p1Usd ?? 0);
      const rawMid = tickToPrice((a + b) / 2);
      const sc = 10 ** (st.base.decimals - st.quote.decimals);
      const price = st.base.isToken0 ? rawMid * sc : 1 / (rawMid * sc);
      bars.push({ tickLower: Math.round(a), tickUpper: Math.round(b), price, liquidity: avg.toString(), usd });
    }
    return { pool, tick: st.tick, price: st.price, priceUsd: st.priceUsd, bars, initialisedTicks: initialised.length };
  });
}

// -------------------------------------------------------------- planner

/**
 * From a human range to contract rungs. Prices are quote-per-base in whole
 * units, as shown on the chart. Amounts are raw units of the base and quote
 * tokens the user is willing to spend.
 */
export async function planPosition({ pool, base, minPrice, maxPrice, shape = "bidask", bins = 40, baseAmount = 0n, quoteAmount = 0n, slippageBps = 100, mode = "split", owner = null, permit = null }) {
  const st = await poolState(pool, base);
  const sc = 10 ** (st.base.decimals - st.quote.decimals);
  // Back to raw token1/token0 ticks. For an inverted pool a higher quote price is a lower tick.
  const toTick = (p) => priceToTick(st.base.isToken0 ? p / sc : 1 / (p * sc));
  const tA = toTick(minPrice), tB = toTick(maxPrice);
  const minTick = Math.min(tA, tB), maxTick = Math.max(tA, tB);
  const budget0 = st.base.isToken0 ? baseAmount : quoteAmount;
  const budget1 = st.base.isToken0 ? quoteAmount : baseAmount;

  // "split" places every token the user typed, Delta's way; "scale" keeps
  // the shape exact and refunds whichever side is in surplus.
  let plan;
  if (mode === "scale") {
    plan = planLadder({ tick: st.tick, tickSpacing: st.tickSpacing, minTick, maxTick, bins, shape, budget0, budget1, slippageBps });
  } else {
    const rs = splitLadder({ tick: st.tick, tickSpacing: st.tickSpacing, minTick, maxTick, bins, shape, budget0, budget1 });
    const total0 = rs.reduce((n, r) => n + r.amount0, 0n), total1 = rs.reduce((n, r) => n + r.amount1, 0n);
    plan = {
      rungs: rs.map((r) => ({ ...r, amount0Min: 0n, amount1Min: 0n, liquidity: 0n })),
      total0, total1,
      minTick: rs.length ? rs[0].tickLower : minTick, maxTick: rs.length ? rs[rs.length - 1].tickUpper : maxTick,
      limitedBy: "none",
      singleSided: maxTick <= st.tick ? 1 : minTick > st.tick ? 0 : null,
    };
  }

  // The contract refuses to mint if the price has left this band by inclusion
  // time. Delta passes the full tick range and minimums of zero; we keep a
  // one-percent band so a fast market cannot mint a shape nobody asked for.
  const band = Math.max(st.tickSpacing, 100);
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const rungs = plan.rungs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, amount0: r.amount0, amount1: r.amount1, amount0Min: r.amount0Min ?? 0n, amount1Min: r.amount1Min ?? 0n }));
  const build = (signed) => signed
    ? encodeFunctionData({ abi: LADDER_ABI, functionName: "openLadderWithPermit", args: [getAddress(st.pool), rungs, shapeCode(shape), st.tick - band, st.tick + band, BigInt(deadline), signed] })
    : encodeFunctionData({ abi: LADDER_ABI, functionName: "openLadder", args: [getAddress(st.pool), rungs, shapeCode(shape), st.tick - band, st.tick + band, BigInt(deadline)] });
  const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : 1 / (raw * sc); };
  return {
    pool: st.pool, tick: st.tick, price: st.price, priceUsd: st.priceUsd,
    base: st.base, quote: st.quote,
    minTick: plan.minTick, maxTick: plan.maxTick,
    minPrice: Math.min(toPrice(plan.minTick), toPrice(plan.maxTick)), maxPrice: Math.max(toPrice(plan.minTick), toPrice(plan.maxTick)),
    shape, mode, bins: plan.rungs.length, limitedBy: plan.limitedBy, singleSided: plan.singleSided,
    total0: plan.total0.toString(), total1: plan.total1.toString(),
    baseTotal: (st.base.isToken0 ? plan.total0 : plan.total1).toString(),
    quoteTotal: (st.base.isToken0 ? plan.total1 : plan.total0).toString(),
    rungs: plan.rungs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, priceLower: Math.min(toPrice(r.tickLower), toPrice(r.tickUpper)), priceUpper: Math.max(toPrice(r.tickLower), toPrice(r.tickUpper)), amount0: r.amount0.toString(), amount1: r.amount1.toString(), weight: r.weight, side: r.side ?? (r.amount0 > 0n && r.amount1 > 0n ? "both" : r.amount0 > 0n ? "token0" : "token1") })),
    tx: rungs.length ? await fundingFor(st, plan.total0, plan.total1, build, deadline, owner, permit) : null,
  };
}

// ---------------------------------------------------------------- permit

const PERMIT_ABI = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const permitSupport = new Map(); // token → { supported, name, version } (never changes for a token)

/**
 * Whether a token can grant an allowance by signature (EIP-2612), and the
 * EIP-712 domain to sign it under. Wallets sign the domain the token
 * declares, so the name is read from the token and the version defaults to
 * "1" when the token exposes none — the OpenZeppelin convention the Robinhood
 * stock tokens, USDG and most launchpad tokens follow.
 */
export async function permitInfo(token, owner) {
  token = lower(token);
  let sup = permitSupport.get(token);
  if (!sup) {
    const [ds, name, version] = await Promise.all([
      call(token, PERMIT_ABI, "DOMAIN_SEPARATOR").catch(() => null),
      call(token, PERMIT_ABI, "name").catch(() => null),
      call(token, PERMIT_ABI, "version").catch(() => "1"),
    ]);
    // `nonces` must answer too, or a wallet cannot build the message.
    const nonceOk = ds != null && (await call(token, PERMIT_ABI, "nonces", ["0x0000000000000000000000000000000000000001"]).then(() => true).catch(() => false));
    sup = { supported: ds != null && name != null && nonceOk, name, version: version || "1", domainSeparator: ds };
    permitSupport.set(token, sup);
  }
  if (!sup.supported) return { supported: false };
  const nonce = owner ? await call(token, PERMIT_ABI, "nonces", [getAddress(owner)]).catch(() => null) : null;
  return { supported: true, token: getAddress(token), name: sup.name, version: sup.version, chainId: CHAIN.id, nonce: nonce == null ? null : nonce.toString() };
}

/** A signed permit from the query string, or null when none was provided. */
export function permitFromQuery(q) {
  const v = q.get("permitV"), r = q.get("permitR"), s = q.get("permitS"), value = q.get("permitValue"), deadline = q.get("permitDeadline");
  if (!v || !r || !s || !value || !deadline) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(r) || !/^0x[0-9a-fA-F]{64}$/.test(s) || !/^\d+$/.test(value) || !/^\d+$/.test(deadline) || !/^\d+$/.test(v)) throw new Error("bad permit");
  return { value: BigInt(value), deadline: BigInt(deadline), v: Number(v), r, s };
}

/** How a deposit is paid: the WETH side as native ETH, anything else by allowance — or by permit when the caller signed one. */
async function fundingFor(st, total0, total1, build, deadline, owner, permit) {
  const wethIsToken0 = st.token0 === WETH;
  const wethNeeded = st.token0 === WETH ? total0 : st.token1 === WETH ? total1 : 0n;
  const other = st.token0 === WETH ? st.token1 : st.token0;
  const otherNeeded = st.token0 === WETH ? total1 : total0;
  const needsToken = otherNeeded > 0n;
  const info = needsToken ? await permitInfo(other, owner).catch(() => ({ supported: false })) : { supported: false };
  const signed = needsToken && permit && info.supported ? { token: getAddress(other), value: permit.value, deadline: permit.deadline, v: permit.v, r: permit.r, s: permit.s } : null;
  return {
    to: getAddress(LADDER_MANAGER), data: build(signed),
    value: wethNeeded.toString(),
    // With a signed permit no approve transaction is needed; the signature rides in the calldata.
    approve: needsToken && !signed ? { token: getAddress(other), amount: otherNeeded.toString(), spender: getAddress(LADDER_MANAGER) } : null,
    permit: needsToken ? { ...info, spender: getAddress(LADDER_MANAGER), value: otherNeeded.toString(), deadline, applied: !!signed } : null,
    wethIsToken0, deadline,
  };
}

/**
 * Top up an open ladder. The bins are the ones already open — same ticks, so
 * the contract deepens each position rather than minting new ones — and the
 * shape is whatever the user picks for the amount being added.
 */
export async function planAdd({ id, shape = "spot", baseAmount = 0n, quoteAmount = 0n, owner = null, permit = null }) {
  const l = await call(LADDER_MANAGER, LADDER_ABI, "ladder", [BigInt(id)]);
  if (l.closedAt !== 0n) throw new Error("ladder is closed");
  const st = await poolState(l.pool, await baseOf(l.pool));
  const open = l.bins.filter((b) => b.open).map((b) => ({ tickLower: Number(b.tickLower), tickUpper: Number(b.tickUpper) })).sort((a, b) => a.tickLower - b.tickLower);
  const budget0 = st.base.isToken0 ? baseAmount : quoteAmount;
  const budget1 = st.base.isToken0 ? quoteAmount : baseAmount;
  const rs = allocateRungs(open, st.tick, shape, budget0, budget1);
  const total0 = rs.reduce((n, r) => n + r.amount0, 0n), total1 = rs.reduce((n, r) => n + r.amount1, 0n);
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const rungs = rs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, amount0: r.amount0, amount1: r.amount1, amount0Min: 0n, amount1Min: 0n }));
  const build = (signed) => signed
    ? encodeFunctionData({ abi: LADDER_ABI, functionName: "addLiquidityWithPermit", args: [BigInt(id), rungs, BigInt(deadline), signed] })
    : encodeFunctionData({ abi: LADDER_ABI, functionName: "addLiquidity", args: [BigInt(id), rungs, BigInt(deadline)] });
  const sc = 10 ** (st.base.decimals - st.quote.decimals);
  const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : 1 / (raw * sc); };
  return {
    id: String(id), pool: st.pool, tick: st.tick, price: st.price, priceUsd: st.priceUsd, base: st.base, quote: st.quote, shape,
    bins: open.length, filled: rs.length,
    total0: total0.toString(), total1: total1.toString(),
    baseTotal: (st.base.isToken0 ? total0 : total1).toString(), quoteTotal: (st.base.isToken0 ? total1 : total0).toString(),
    rungs: rs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, priceLower: Math.min(toPrice(r.tickLower), toPrice(r.tickUpper)), priceUpper: Math.max(toPrice(r.tickLower), toPrice(r.tickUpper)), amount0: r.amount0.toString(), amount1: r.amount1.toString(), weight: r.weight, side: r.side })),
    tx: rungs.length ? await fundingFor(st, total0, total1, build, deadline, owner, permit) : null,
  };
}

// ------------------------------------------------------------ positions

/**
 * A token's dollar price at a moment in the past, from our own candles. Used
 * to value deposits when they went in and withdrawals when they came out, so
 * PnL is what actually happened rather than everything marked at today's
 * price. Minute candles for recent events, hourly for older ones.
 */
const usdAtCache = new Map();
async function usdAt(token, ts) {
  token = lower(token);
  if (token === USDG) return 1;
  const now = Math.floor(Date.now() / 1000);
  const age = Math.max(0, now - ts);
  if (age < 120) return token === WETH ? (await ethUsd().catch(() => null)) : (await tokenInfo(token)).usdPerToken;
  const bucketSec = age > 2 * 86_400 ? 3600 : 60;
  const key = `${token}:${Math.floor(ts / bucketSec)}`;
  if (usdAtCache.has(key)) return usdAtCache.get(key);
  const hours = Math.ceil(age / 3600) + 2;
  // Only our own tape is consulted; when it does not reach back to `ts` the
  // live price stands in rather than an eth_getLogs walk stalling the page.
  const closeAt = async (base, quote) => {
    const found = await bestPool(base === "eth" ? WETH : base, quote === "eth" ? WETH : quote);
    const cov = found && STORE?.candleCoverage?.(found.pool);
    if (!cov || cov.from > ts) return null;
    const c = await tradeCandles({ base, quote, bucketSec, hours, store: STORE });
    let last = null;
    for (const x of c.candles) { if (x.time <= ts) last = x; else break; }
    return last?.close ?? null;
  };
  let usd = null;
  try {
    if (token === WETH) usd = await closeAt("eth", USDG);
    else if (await bestPool(token, WETH)) { const inEth = await closeAt(token, "eth"); const eth = await usdAt(WETH, ts); usd = inEth != null && eth != null ? inEth * eth : null; }
    else if (await bestPool(token, USDG)) usd = await closeAt(token, USDG);
  } catch { /* fall through to the live price */ }
  if (usd == null) usd = token === WETH ? await ethUsd().catch(() => null) : (await tokenInfo(token)).usdPerToken;
  usdAtCache.set(key, usd);
  return usd;
}

// ---- the manager's event log for one owner, read incrementally

const logCache = new Map(); // owner → { toBlock, logs }
const receiptCache = new Map(); // hash → receipt
const blockTsCache = new Map(); // blockNumber → unix seconds
const pad32 = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

/**
 * Reads that need history — eth_getLogs over the manager's whole life, old
 * receipts, old blocks — go to an archive-capable upstream first. The free
 * public nodes refuse historical getLogs outright ("archive requests require
 * a personal token"), and the failure used to be swallowed further up, which
 * left the PnL calendar empty without a word. Falls back to the general list.
 */
const ARCHIVE_URLS = (process.env.ORDO_ARCHIVE_RPC ?? "").split(",").map((s) => s.trim()).filter(Boolean);
async function archiveFetch(method, params) {
  let lastErr = null;
  for (const url of ARCHIVE_URLS) {
    try { return await rpcOnce(url, method, params, 20_000); } catch (e) { lastErr = e; }
  }
  try { return await rpcFetch(method, params); } catch (e) { throw lastErr ?? e; }
}

async function ownerLogs(owner) {
  const cur = logCache.get(owner) ?? { toBlock: LADDER_DEPLOY_BLOCK - 1, logs: [] };
  const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
  let from = cur.toBlock + 1;
  let span = 400_000;
  while (from <= head) {
    const to = Math.min(head, from + span - 1);
    try {
      const part = await archiveFetch("eth_getLogs", [{ address: LADDER_MANAGER, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [MANAGER_TOPICS, null, pad32(owner)] }]);
      cur.logs.push(...part);
      from = to + 1;
    } catch (e) {
      if (span <= 2_000) throw e;
      span = Math.floor(span / 4);
    }
  }
  cur.toBlock = head;
  logCache.set(owner, cur);
  return cur.logs;
}

async function receiptOf(hash) {
  if (receiptCache.has(hash)) return receiptCache.get(hash);
  const r = await archiveFetch("eth_getTransactionReceipt", [hash]);
  if (r) receiptCache.set(hash, r);
  return r;
}
async function blockTs(bn) {
  const n = Number(bn);
  if (blockTsCache.has(n)) return blockTsCache.get(n);
  const b = await archiveFetch("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  const ts = parseInt(b.timestamp, 16);
  blockTsCache.set(n, ts);
  return ts;
}

/**
 * Everything that ever happened to an owner's ladders, priced at the time it
 * happened: what went in (per bin, from the position manager's own events),
 * what came out, fees claimed, gas paid. This is the ground truth the PnL
 * calendar and every position card are built from.
 */
async function historyOf(owner) {
  const logs = await ownerLogs(owner);
  const byLadder = new Map();
  const txs = new Map(); // hash → { ts, gasEth, events: [], npm: Map(tokenId → flows) }
  for (const lg of logs) {
    let ev;
    try { ev = decodeEventLog({ abi: LADDER_ABI, data: lg.data, topics: lg.topics }); } catch { continue; }
    const id = ev.args.ladderId.toString();
    const tx = txs.get(lg.transactionHash) ?? { hash: lg.transactionHash, block: Number(BigInt(lg.blockNumber)), ts: 0, gasEth: 0, events: [] };
    tx.events.push({ name: ev.eventName, args: ev.args, ladderId: id });
    txs.set(lg.transactionHash, tx);
    if (!byLadder.has(id)) byLadder.set(id, new Set());
    byLadder.get(id).add(lg.transactionHash);
  }
  await Promise.all([...txs.values()].map(async (tx) => {
    const [r, ts] = await Promise.all([receiptOf(tx.hash), blockTs(tx.block)]);
    tx.ts = ts;
    tx.gasEth = r ? Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? "0x0")) / 1e18 : 0;
    tx.npm = new Map();
    for (const lg of r?.logs ?? []) {
      if (lower(lg.address) !== NPM) continue;
      const name = NPM_TOPICS.get(lg.topics[0]);
      if (!name) continue;
      try {
        const ev = decodeEventLog({ abi: NPM_EVENTS, data: lg.data, topics: lg.topics });
        const tid = ev.args.tokenId.toString();
        const f = tx.npm.get(tid) ?? { inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n };
        if (name === "IncreaseLiquidity") { f.inc0 += ev.args.amount0; f.inc1 += ev.args.amount1; }
        else if (name === "DecreaseLiquidity") { f.dec0 += ev.args.amount0; f.dec1 += ev.args.amount1; }
        else { f.col0 += ev.args.amount0; f.col1 += ev.args.amount1; }
        tx.npm.set(tid, f);
      } catch { /* not ours */ }
    }
  }));
  return { byLadder, txs };
}

/**
 * Every ladder a wallet holds or held: live value, claimable fees, what went
 * in and came out at the prices of the day, gas, and the realised PnL that
 * each close landed on its day — the same accounting a broker statement uses.
 */
export async function positionsOf(store, owner) {
  owner = getAddress(owner);
  return cached(`portfolio:${owner}`, 8_000, () => buildPortfolio(owner));
}

async function buildPortfolio(owner) {
  const ids = await call(LADDER_MANAGER, LADDER_ABI, "laddersOf", [owner]);
  const usd = await ethUsd().catch(() => null);
  const empty = { owner, manager: LADDER_MANAGER, ethUsd: usd, ladders: [], days: {}, totals: { valueUsd: 0, unclaimedUsd: 0, claimedUsd: 0, depositedUsd: 0, pnlUsd: 0, open: 0, closed: 0 } };
  if (!ids.length) return empty;
  let historyError = null;
  const [ladders, hist] = await Promise.all([
    batchCall(ids.map((id) => ({ to: LADDER_MANAGER, abi: LADDER_ABI, fn: "ladder", args: [id] }))),
    historyOf(owner).catch((e) => { historyError = e?.message ?? String(e); console.warn(`pools | history for ${owner} unavailable: ${historyError}`); return { byLadder: new Map(), txs: new Map() }; }),
  ]);
  const out = [];
  const days = {};
  const land = async (ts, pnlUsd, gasUsd, kind) => {
    const d = new Date(ts * 1000).toISOString().slice(0, 10);
    const eth = await usdAt(WETH, ts);
    const row = days[d] ?? (days[d] = { pnlUsd: 0, pnlEth: 0, gasUsd: 0, closes: 0, collects: 0 });
    row.pnlUsd += pnlUsd;
    row.pnlEth += eth ? pnlUsd / eth : 0;
    row.gasUsd += gasUsd;
    if (kind === "close") row.closes++; else row.collects++;
  };

  // Each ladder is a dozen dependent reads; a wallet with many of them should
  // not wait for them one after another. A handful in flight keeps within the
  // upstream's per-second allowance.
  const CONCURRENCY = 4;
  const buildLadder = async (i) => {
    const l = ladders[i];
    if (!l) return;
    const id = ids[i].toString();
    const st = await poolState(l.pool, await baseOf(l.pool)).catch(() => null);
    if (!st) return;
    const d0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals);
    const d1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
    const p0 = st.base.isToken0 ? st.priceUsd : st.quote.usdPerToken;
    const p1 = st.base.isToken0 ? st.quote.usdPerToken : st.priceUsd;
    const valNow = (a0, a1) => (Number(a0) / d0) * (p0 ?? 0) + (Number(a1) / d1) * (p1 ?? 0);
    const valAt = async (a0, a1, ts) => {
      const [u0, u1] = await Promise.all([usdAt(st.token0, ts), usdAt(st.token1, ts)]);
      return (Number(a0) / d0) * (u0 ?? p0 ?? 0) + (Number(a1) / d1) * (u1 ?? p1 ?? 0);
    };
    const sc = 10 ** (st.base.decimals - st.quote.decimals);
    const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : 1 / (raw * sc); };

    // Live holdings per bin.
    const openBins = l.bins.map((b, k) => ({ ...b, index: k })).filter((b) => b.open);
    const posRaw = await batchCall(openBins.map((b) => ({ to: NPM, abi: NPM_ABI, fn: "positions", args: [b.tokenId] })));
    const sqrtP = tickToSqrtPriceX96(st.tick);
    let held0 = 0n, held1 = 0n;
    const liveByIndex = new Map();
    posRaw.forEach((p, k) => {
      if (!p) return;
      const a = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(Number(p[5])), tickToSqrtPriceX96(Number(p[6])), BigInt(p[7]));
      held0 += a.amount0; held1 += a.amount1;
      liveByIndex.set(openBins[k].index, { liquidity: p[7].toString(), amount0: a.amount0, amount1: a.amount1 });
    });
    const bins = l.bins.map((b, k) => {
      const live = liveByIndex.get(k);
      const tl = Number(b.tickLower), tu = Number(b.tickUpper);
      return {
        index: k, tokenId: b.tokenId.toString(), tickLower: tl, tickUpper: tu, open: b.open,
        priceLower: Math.min(toPrice(tl), toPrice(tu)), priceUpper: Math.max(toPrice(tl), toPrice(tu)),
        liquidity: live?.liquidity ?? "0", amount0: (live?.amount0 ?? 0n).toString(), amount1: (live?.amount1 ?? 0n).toString(),
        usd: live ? valNow(live.amount0, live.amount1) : 0,
        inRange: b.open && st.tick >= tl && st.tick < tu,
        side: st.tick >= tu ? "token1" : st.tick < tl ? "token0" : "both",
      };
    });

    // What collect() would pay right now, net of the 1%.
    let fee0 = 0n, fee1 = 0n;
    if (l.closedAt === 0n) {
      try { const [f0, f1] = await call(LADDER_MANAGER, LADDER_ABI, "collect", [ids[i]], owner); fee0 = BigInt(f0); fee1 = BigInt(f1); } catch { /* nothing accrued */ }
    }

    // History: cost basis per bin at deposit-time prices, realised PnL per close, gas.
    const cost = new Map(); // tokenId → usd put in
    let depositedUsd = 0, gasOpenUsd = 0, gasOpenEth = 0, gasAllEth = 0, gasAllUsd = 0, realizedUsd = 0, returnedUsd = 0, claimedUsd = 0;
    const events = [];
    const hashes = [...(hist.byLadder.get(id) ?? [])].map((h) => hist.txs.get(h)).filter(Boolean).sort((a, b) => a.ts - b.ts);
    for (const tx of hashes) {
      const mine = tx.events.filter((e) => e.ladderId === id);
      const ethAt = await usdAt(WETH, tx.ts);
      const gasUsd = tx.gasEth * (ethAt ?? usd ?? 0);
      gasAllEth += tx.gasEth; gasAllUsd += gasUsd;
      const opened = mine.find((e) => e.name === "LadderOpened"), added = mine.find((e) => e.name === "LiquidityAdded");
      const closed = mine.find((e) => e.name === "BinsClosed"), fees = mine.find((e) => e.name === "FeesCollected");
      const myTokenIds = new Set(l.bins.map((b) => b.tokenId.toString()));
      if (opened || added) {
        let in0 = 0n, in1 = 0n;
        for (const [tid, f] of tx.npm) { if (myTokenIds.has(tid) && (f.inc0 || f.inc1)) { const u = await valAt(f.inc0, f.inc1, tx.ts); cost.set(tid, (cost.get(tid) ?? 0) + u); in0 += f.inc0; in1 += f.inc1; } }
        const inUsd = await valAt(in0, in1, tx.ts);
        depositedUsd += inUsd; gasOpenUsd += gasUsd; gasOpenEth += tx.gasEth;
        events.push({ type: opened ? "open" : "add", ts: tx.ts, tx: tx.hash, amount0: in0.toString(), amount1: in1.toString(), usd: inUsd, gasEth: tx.gasEth, gasUsd });
      }
      if (closed) {
        const f0 = fees ? fees.args.toOwner0 : 0n, f1 = fees ? fees.args.toOwner1 : 0n;
        const outUsd = await valAt(closed.args.principal0 + f0, closed.args.principal1 + f1, tx.ts);
        let closedCost = 0;
        for (const [tid, f] of tx.npm) { if (myTokenIds.has(tid) && (f.dec0 || f.dec1 || (!f.inc0 && !f.inc1 && (f.col0 || f.col1)))) { closedCost += cost.get(tid) ?? 0; cost.delete(tid); } }
        const pnl = outUsd - closedCost;
        realizedUsd += pnl; returnedUsd += outUsd;
        if (fees) claimedUsd += await valAt(f0, f1, tx.ts);
        await land(tx.ts, pnl, gasUsd, "close");
        events.push({ type: "close", ts: tx.ts, tx: tx.hash, bins: Number(closed.args.count), remaining: Number(closed.args.remaining), amount0: (closed.args.principal0 + f0).toString(), amount1: (closed.args.principal1 + f1).toString(), usd: outUsd, costUsd: closedCost, pnlUsd: pnl, gasEth: tx.gasEth, gasUsd });
      } else if (fees) {
        const feeUsd = await valAt(fees.args.toOwner0, fees.args.toOwner1, tx.ts);
        const pnl = feeUsd;
        realizedUsd += pnl; claimedUsd += feeUsd;
        await land(tx.ts, pnl, gasUsd, "collect");
        events.push({ type: "collect", ts: tx.ts, tx: tx.hash, amount0: fees.args.toOwner0.toString(), amount1: fees.args.toOwner1.toString(), usd: feeUsd, pnlUsd: pnl, gasEth: tx.gasEth, gasUsd });
      }
    }
    // Ladders whose history has not been indexed yet still get a price-now estimate.
    const openCostUsd = [...cost.values()].reduce((n, v) => n + v, 0) || (l.closedAt === 0n ? valNow(l.deposited0 - l.withdrawn0, l.deposited1 - l.withdrawn1) : 0);
    if (!hashes.length) depositedUsd = valNow(l.deposited0, l.deposited1);

    const isOpen = l.closedAt === 0n;
    const valueUsd = isOpen ? valNow(held0, held1) : 0;
    const unclaimedUsd = valNow(fee0, fee1);
    const unrealizedUsd = isOpen ? valueUsd + unclaimedUsd - openCostUsd : 0;
    const pnlUsd = unrealizedUsd + realizedUsd; // before gas; `netUsd` is after
    const openedAt = Number(l.openedAt), closedAt = Number(l.closedAt);
    out.push({
      id, pool: l.pool, fee: st.fee, closed: !isOpen, openedAt, closedAt: closedAt || null,
      shape: SHAPES[Number(l.shape)] ?? "bidask", binCount: l.bins.length, openBins: Number(l.openBins),
      base: st.base, quote: st.quote, token0: st.token0, token1: st.token1, price: st.price, priceUsd: st.priceUsd, tick: st.tick,
      deposited0: l.deposited0.toString(), deposited1: l.deposited1.toString(), depositedUsd,
      withdrawn0: l.withdrawn0.toString(), withdrawn1: l.withdrawn1.toString(),
      held0: held0.toString(), held1: held1.toString(), valueUsd,
      unclaimed0: fee0.toString(), unclaimed1: fee1.toString(), unclaimedUsd,
      collected0: l.collected0.toString(), collected1: l.collected1.toString(), claimedUsd,
      costUsd: openCostUsd, gasEth: gasAllEth, gasUsd: gasAllUsd,
      returnedUsd: isOpen ? valueUsd + unclaimedUsd + returnedUsd : returnedUsd, // what is out or could come out now, plus what already did
      unrealizedUsd, realizedUsd, pnlUsd, netUsd: pnlUsd - gasAllUsd,
      pnlPct: depositedUsd > 0 ? pnlUsd / depositedUsd : null,
      inRange: bins.some((b) => b.inRange),
      minTick: Math.min(...l.bins.map((b) => Number(b.tickLower))), maxTick: Math.max(...l.bins.map((b) => Number(b.tickUpper))),
      minPrice: Math.min(...bins.map((b) => b.priceLower)), maxPrice: Math.max(...bins.map((b) => b.priceUpper)),
      bins, events,
    });
  };
  let next = 0;
  const worker = async () => { while (next < ids.length) { const i = next++; await buildLadder(i); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  const totals = out.reduce((t, l) => ({
    valueUsd: t.valueUsd + l.valueUsd, unclaimedUsd: t.unclaimedUsd + l.unclaimedUsd, claimedUsd: t.claimedUsd + l.claimedUsd,
    depositedUsd: t.depositedUsd + (l.closed ? 0 : l.depositedUsd), pnlUsd: t.pnlUsd + l.pnlUsd, gasUsd: t.gasUsd + l.gasUsd,
    open: t.open + (l.closed ? 0 : 1), closed: t.closed + (l.closed ? 1 : 0),
  }), { valueUsd: 0, unclaimedUsd: 0, claimedUsd: 0, depositedUsd: 0, pnlUsd: 0, gasUsd: 0, open: 0, closed: 0 });
  return { owner, manager: LADDER_MANAGER, ethUsd: usd, ladders: out.sort((a, b) => b.openedAt - a.openedAt), days, totals, historyError };
}

// ------------------------------------------------------------ platform

const FEES_TOPIC = toEventSelector(LADDER_ABI.find((x) => x.type === "event" && x.name === "FeesCollected"));
const feeLogCache = { toBlock: LADDER_DEPLOY_BLOCK - 1, logs: [] };
/** Every FeesCollected the manager ever emitted, for every owner, read incrementally. */
async function allFeeLogs() {
  const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
  let from = feeLogCache.toBlock + 1, span = 400_000;
  while (from <= head) {
    const to = Math.min(head, from + span - 1);
    try {
      const part = await archiveFetch("eth_getLogs", [{ address: LADDER_MANAGER, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [FEES_TOPIC] }]);
      feeLogCache.logs.push(...part);
      from = to + 1;
    } catch (e) {
      if (span <= 2_000) throw e;
      span = Math.floor(span / 4);
    }
  }
  feeLogCache.toBlock = head;
  return feeLogCache.logs;
}

/**
 * The numbers in the header of every liquidity page — the same four Delta
 * shows: positions ever built, fees earned by LPs (owner share plus the 1%,
 * each valued the day it was collected), what is in open positions now, and
 * the ETH price. Stakes are folded in by the caller, which knows them.
 */
export async function platformStats({ stakesTvlUsd = 0, stakesFeesUsd = 0, stakes = 0 } = {}) {
  return cached("platform", 60_000, async () => {
    const [countRaw, usd] = await Promise.all([call(LADDER_MANAGER, LADDER_ABI, "ladderCount").catch(() => 0n), ethUsd().catch(() => null)]);
    const count = Number(countRaw);
    const ids = Array.from({ length: count }, (_, i) => BigInt(i));
    const ladders = count ? await batchCall(ids.map((id) => ({ to: LADDER_MANAGER, abi: LADDER_ABI, fn: "ladder", args: [id] }))) : [];
    const byId = new Map(ladders.map((l, i) => [String(i), l]).filter(([, l]) => l));

    // Open value: every live bin, priced at the pool's current tick.
    const openBins = [];
    for (const l of ladders) { if (!l || l.closedAt !== 0n) continue; for (const b of l.bins) if (b.open) openBins.push({ tokenId: b.tokenId, pool: lower(l.pool) }); }
    const states = new Map();
    for (const p of new Set(openBins.map((b) => b.pool))) states.set(p, await poolState(p, await baseOf(p)).catch(() => null));
    const valNow = (st, a0, a1) => {
      const d0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals), d1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
      const p0 = st.base.isToken0 ? st.priceUsd : st.quote.usdPerToken, p1 = st.base.isToken0 ? st.quote.usdPerToken : st.priceUsd;
      return (Number(a0) / d0) * (p0 ?? 0) + (Number(a1) / d1) * (p1 ?? 0);
    };
    let ladderTvlUsd = 0;
    const pos = openBins.length ? await batchCall(openBins.map((b) => ({ to: NPM, abi: NPM_ABI, fn: "positions", args: [b.tokenId] }))) : [];
    pos.forEach((p, i) => {
      const st = states.get(openBins[i].pool); if (!p || !st) return;
      const a = amountsForLiquidity(tickToSqrtPriceX96(st.tick), tickToSqrtPriceX96(Number(p[5])), tickToSqrtPriceX96(Number(p[6])), BigInt(p[7]));
      ladderTvlUsd += valNow(st, a.amount0, a.amount1);
    });

    // Fees ever collected, owner share plus treasury, at the price of the day.
    let ladderFeesUsd = 0;
    try {
      const logs = await allFeeLogs();
      for (const lg of logs) {
        let ev; try { ev = decodeEventLog({ abi: LADDER_ABI, data: lg.data, topics: lg.topics }); } catch { continue; }
        const l = byId.get(ev.args.ladderId.toString()); if (!l) continue;
        const pool = lower(l.pool);
        if (!states.has(pool)) states.set(pool, await poolState(pool, await baseOf(pool)).catch(() => null));
        const st = states.get(pool); if (!st) continue;
        const ts = await blockTs(lg.blockNumber);
        const [u0, u1] = await Promise.all([usdAt(st.token0, ts), usdAt(st.token1, ts)]);
        const d0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals), d1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
        ladderFeesUsd += (Number(ev.args.toOwner0 + ev.args.toTreasury0) / d0) * (u0 ?? 0) + (Number(ev.args.toOwner1 + ev.args.toTreasury1) / d1) * (u1 ?? 0);
      }
    } catch (e) { console.warn(`pools | platform fees unavailable: ${e?.message ?? e}`); }

    return {
      totalPositions: count, openPositions: ladders.filter((l) => l && l.closedAt === 0n).length, stakes,
      totalFeesUsd: ladderFeesUsd + stakesFeesUsd, ladderFeesUsd, stakesFeesUsd,
      tvlUsd: ladderTvlUsd + stakesTvlUsd, ladderTvlUsd, stakesTvlUsd,
      ethUsd: usd, at: new Date().toISOString(),
    };
  });
}

const mgr = () => getAddress(LADDER_MANAGER);
export const collectCalldata = (id) => ({ to: mgr(), data: encodeFunctionData({ abi: LADDER_ABI, functionName: "collect", args: [BigInt(id)] }) });
export const closeCalldata = (id) => ({ to: mgr(), data: encodeFunctionData({ abi: LADDER_ABI, functionName: "close", args: [BigInt(id)] }) });
export const closeBinsCalldata = (id, indices) => ({ to: mgr(), data: encodeFunctionData({ abi: LADDER_ABI, functionName: "closeBins", args: [BigInt(id), indices.map((i) => BigInt(i))] }) });
export const closeManyCalldata = (ids) => ({ to: mgr(), data: encodeFunctionData({ abi: LADDER_ABI, functionName: "closeMany", args: [ids.map((i) => BigInt(i))] }) });
