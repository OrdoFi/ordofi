import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog, encodeFunctionData, getAddress, parseAbiItem, toEventSelector } from "viem";
import { rpcFetch, rpcOnce, V4, isV4PoolId } from "@ordofi/core";
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
import { CHAIN, USDG, WETH, bestPool, bestPoolV4, factoryPoolsFor, poolCache, rememberTokenNames, tokenMetaOf, tradeCandles, tradeMarkets, tradeTokens } from "./trade.mjs";
import { batchCall, call } from "./rpc.mjs";
import {
  LADDER_V4_ABI, LADDER_V4_TOPICS, MODIFY_LIQUIDITY_EVENT, MODIFY_LIQUIDITY_TOPIC, POSM_ABI,
  SPACING_FOR_FEE, holdings as v4Holdings, initializeCalldata, isPlainMoneyPool, keyArg, keyFromChain, liquidityOf as v4LiquidityOf, poolKeyOf, segmentsOf, slot0 as v4Slot0, sqrtPricesOf, tickProfile as v4TickProfile, tokensOf,
} from "./v4.mjs";

/**
 * Liquidity provision on Uniswap V3 and V4 pools, the way a person would want
 * to do it: pick a token, see where liquidity sits, drag a range, choose a
 * shape, and mint the whole ladder in one transaction through OrdoLadderManager
 * (V3 pools) or OrdoLadderManagerV4 (V4 pools).
 *
 * This module is the read side and the planner. It never signs anything; it
 * turns "I want a curve from $2,300 to $2,600 with 1 ETH" into the exact rungs
 * the contract will mint, and it reads back what a wallet already holds.
 *
 * A pool is named by its key: a 20-byte address for V3, a 32-byte PoolId for
 * V4. Everything downstream branches on that, and every ladder carries a
 * `venue` so the front end can send its actions to the right manager.
 */

/** v3: the v2 manager plus EIP-2612 permit entry points. */
// `||`, not `??`: compose passes unset overrides through as empty strings.
export const LADDER_MANAGER = process.env.ORDO_LADDER_ADDRESS || "0xf9b15283AcbDd693d39d23AccDA7213d8d46a9E2";
/** Block the manager was deployed in; event scans never look further back. */
const LADDER_DEPLOY_BLOCK = Number(process.env.ORDO_LADDER_BLOCK || 52_895_364);
export const LADDER_MANAGER_V4 = process.env.ORDO_LADDER_V4_ADDRESS || V4.ladderManager;
const LADDER_V4_DEPLOY_BLOCK = Number(process.env.ORDO_LADDER_V4_BLOCK || V4.ladderDeployBlock);
const NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const NATIVE = "eth";
export const VENUES = ["v3", "v4"];
export const venueOf = (pool) => (isV4PoolId(pool) ? "v4" : "v3");
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
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
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

// --------------------------------------------------------------- venues

/**
 * What differs between the two managers, in one place: address, ABI, the
 * block to scan events from, and how a bin's live liquidity is read — the V3
 * position manager answers per token id with its range; V4's answers with
 * liquidity alone and the range comes from our own bin record.
 */
const V3_VENUE = {
  id: "v3", manager: LADDER_MANAGER, abi: LADDER_ABI, deployBlock: LADDER_DEPLOY_BLOCK,
  topics: MANAGER_TOPICS,
  async binLiquidity(bins) {
    const raw = await batchCall(bins.map((b) => ({ to: NPM, abi: NPM_ABI, fn: "positions", args: [b.tokenId] })));
    return raw.map((p, i) => (p ? { tickLower: Number(p[5]), tickUpper: Number(p[6]), liquidity: BigInt(p[7]) } : { tickLower: Number(bins[i].tickLower), tickUpper: Number(bins[i].tickUpper), liquidity: null }));
  },
  poolOf: (l) => lower(l.pool),
};
const V4_VENUE = {
  id: "v4", manager: LADDER_MANAGER_V4, abi: LADDER_V4_ABI, deployBlock: LADDER_V4_DEPLOY_BLOCK,
  topics: LADDER_V4_TOPICS,
  async binLiquidity(bins) {
    const raw = await batchCall(bins.map((b) => ({ to: V4.positionManager, abi: POSM_ABI, fn: "getPositionLiquidity", args: [b.tokenId] })));
    return raw.map((liq, i) => ({ tickLower: Number(bins[i].tickLower), tickUpper: Number(bins[i].tickUpper), liquidity: liq == null ? null : BigInt(liq) }));
  },
  poolOf: (l) => lower(l.poolId),
};
const VENUE = { v3: V3_VENUE, v4: V4_VENUE };
const venueFor = (venue) => VENUE[venue] ?? V3_VENUE;

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
/** Mark a cached value stale without dropping it: the next reader still gets it at once. */
const soften = (key) => { const hit = cache.get(key); if (hit) hit.at = 0; };

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
        if (++since % 10 === 0) { persistIcons(); soften("list"); }
      }
    };
    await Promise.all(Array.from({ length: 2 }, worker));
    persistIcons();
    soften("list"); // the next list rebuild carries the new logos
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
  return cachedSWR("list", 60_000, async () => {
    const [markets, tokens] = await Promise.all([tradeMarkets(store), tradeTokens(store)]);
    const tokenBy = new Map(tokens.map((t) => [t.address, t]));
    const byToken = new Map();
    for (const m of markets.markets ?? []) {
      const baseAddr = m.base.address === NATIVE ? WETH : m.base.address;
      if (isMoney(baseAddr)) continue;
      // A zero-fee pool pays its LPs nothing and is where bots cycle notional
      // volume for free (one printed $34B in a day); it is not a market to rank.
      if (m.fee === 0) continue;
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

    // Market cap: total supply × price, cached for an hour per token. The ones
    // due go over in batches rather than a thousand single calls at once.
    const rows = [...byToken.values()];
    const due = rows.filter((r) => { const h = cache.get(`supply:${r.token}`); return !h || Date.now() - h.at >= 3_600_000; });
    if (due.length) {
      const got = await batchCall(due.map((r) => ({ to: r.token, abi: ERC20_ABI, fn: "totalSupply" })));
      due.forEach((r, i) => { if (got[i] != null) cache.set(`supply:${r.token}`, { at: Date.now(), v: got[i] }); });
    }
    rows.forEach((r) => { const s = cache.get(`supply:${r.token}`)?.v; r.marketCapUsd = s != null && r.priceUsd ? Number(s) / 10 ** r.decimals * r.priceUsd : null; });
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
    return { trending, established, all, featured: { mostTraded, highestVolume }, totals, manager: LADDER_MANAGER, managers: { v3: LADDER_MANAGER, v4: LADDER_MANAGER_V4 }, at: new Date().toISOString() };
  });
}

/** OrdoFi's own token: the page's lead card is always its market. */
export const ORDO_TOKEN = "0xfe2f0fb0c00d19786a8abf98d4b1f1ac8763b167";

/** The list without its long tail — what the page downloads — led by $ORDO. */
export async function poolsPage(store) {
  const { all, ...page } = await poolsList(store);
  return { ...page, hero: await heroRow(store, all) };
}
/**
 * $ORDO's row for the lead card: from the ranked list when it traded today,
 * otherwise built from its deepest pool so the card never goes blank.
 */
async function heroRow(store, all) {
  const ranked = all.find((r) => r.token === ORDO_TOKEN);
  if (ranked) {
    // Its market runs a hook-set fee, which the list counts as nothing; the pool itself knows the rate in force.
    if (ranked.kind === "v4" && !ranked.fees24Usd && ranked.volume24Usd > 0 && ranked.pool) {
      const st = await cachedSWR(`hero:fee:${ranked.pool}`, 60_000, () => poolState(ranked.pool, ORDO_TOKEN)).catch(() => null);
      if (st?.fee) return { ...ranked, fees24Usd: ranked.volume24Usd * (st.fee / 1e6) };
    }
    return ranked;
  }
  return cachedSWR("hero:ordo", 60_000, async () => {
    const pools = await poolsForToken(ORDO_TOKEN);
    const main = pools[0] ?? null; // deepest first, dust counted as empty
    const st = main ? await poolState(main.pool, ORDO_TOKEN).catch(() => null) : null;
    const t = tokenMetaOf(ORDO_TOKEN);
    return {
      token: ORDO_TOKEN, symbol: st?.base.symbol ?? t?.symbol ?? "ORDO", name: st?.base.name ?? t?.name ?? "OrdoFi", icon: iconFor(ORDO_TOKEN), decimals: st?.base.decimals ?? 18,
      priceUsd: st?.priceUsd ?? null, change24: null, volume24Usd: 0, fees24Usd: 0, trades24: 0,
      pool: main?.pool ?? null, kind: main?.kind ?? "v4", quote: main?.quoteSymbol ?? "ETH", quotes: main ? [main.quoteSymbol] : [], venues: main ? [main.kind] : [], pools: pools.length,
      marketCapUsd: st?.marketCapUsd ?? null, ageDays: store?.candleCoverage?.(main?.pool)?.from ? Math.floor((Date.now() / 1000 - store.candleCoverage(main.pool).from) / 86_400) : null,
    };
  });
}
/** One token's row from the ranked list, for the pool page header. */
export async function poolsRow(store, token) {
  const t = lower(token);
  return (await poolsList(store)).all.find((r) => r.token === t) ?? null;
}
/**
 * Build the list at boot and keep it fresh from a timer, so the first visitor
 * after a restart — and every visitor after — gets a page, never the rebuild.
 */
export function warmPoolsList(store) {
  const tick = () => poolsList(store).catch(() => {});
  const index = () => searchIndex(store).catch(() => {});
  // The list is stale-while-revalidate, so a visitor never waits on a rebuild; once a
  // minute is as fresh as a 24h ranking needs, and the market query runs on the
  // event loop, so every rebuild is time no request is being answered.
  tick().then(index);
  setInterval(tick, 60_000).unref?.();
  setInterval(index, 120_000).unref?.();
}

// --------------------------------------------------------------- search

/**
 * The search box's index: every token with a pool against ETH or USDG — the
 * ones a position can be built on — with the ranking the list already knows
 * (24h volume, then market cap, then holders). Compact rows, fetched once by
 * the page and matched in the browser, so typing costs no round trip.
 */
export async function searchIndex(store, { all = false } = {}) {
  const full = await cachedSWR("search-index", 60_000, async () => {
    const [list, tokens] = await Promise.all([poolsList(store), tradeTokens(store)]);
    const ranked = new Map(list.all.map((r) => [r.token, r]));
    const known = new Map(tokens.map((t) => [t.address, t]));
    const universe = new Set(ranked.keys());
    for (const p of poolCache.cache.values()) {
      if (!p || p.miss || !p.v3) continue;
      if (isMoney(p.token0) && !isMoney(p.token1)) universe.add(p.token1);
      else if (isMoney(p.token1) && !isMoney(p.token0)) universe.add(p.token0);
    }
    for (const p of store?.v4PoolsFor?.(V4.nativeCurrency) ?? []) {
      const other = p.currency0 === V4.nativeCurrency ? p.currency1 : p.currency0;
      if (!isMoney(other)) universe.add(lower(other));
    }
    const rows = [], unnamed = [];
    for (const a of universe) {
      const r = ranked.get(a), k = known.get(a), m = tokenMetaOf(a);
      const symbol = r?.symbol ?? k?.symbol ?? m?.symbol;
      if (!symbol) continue;
      const row = [a, symbol, (r?.name || k?.name || m?.name || "").slice(0, 40), r?.marketCapUsd ?? null, r?.volume24Usd ?? 0, k?.holders ?? m?.holders ?? 0];
      if (!row[2]) unnamed.push(row);
      rows.push(row);
    }
    // The explorer knows no name for some launchpad tokens; the contract does.
    // Asked once, in batches, and remembered in the registry.
    if (unnamed.length) {
      const names = await batchCall(unnamed.slice(0, 1_200).map((r) => ({ to: r[0], abi: ERC20_ABI, fn: "name" }))).catch(() => []);
      const learned = [];
      unnamed.forEach((r, i) => { const n = typeof names[i] === "string" ? names[i].trim().slice(0, 40) : ""; if (n) { r[2] = n; learned.push([r[0], n]); } });
      rememberTokenNames(learned);
    }
    rows.sort((x, y) => (y[4] - x[4]) || ((y[3] ?? 0) - (x[3] ?? 0)) || (y[5] - x[5]));
    const compact = rows.map((r) => r.slice(0, 5));
    // Two sizes: what the page prefetches (every token with a market) and the
    // long tail it fetches the first time someone types.
    return { tokens: compact, ranked: compact.filter((r) => r[4] > 0 || r[3]), at: new Date().toISOString() };
  });
  return { tokens: all ? full.tokens : full.ranked, complete: all, at: full.at };
}

/**
 * Token logos served from here rather than hot-linked: the sources block or
 * rate-limit browsers, and one fetch cached on disk serves everyone after.
 * Source order is the curated map, the probe cache, the explorer's registry,
 * the ranked list, then DexScreener's per-address image. A token nothing knows
 * is remembered as such for a day so the page stops asking.
 */
const ICON_DIR = join(dirname(ICON_CACHE_FILE), "icons");
const iconMiss = new Map(); // address → at
const iconInflight = new Map();
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|avif)/;
export async function iconImage(address) {
  const a = lower(address);
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  const file = join(ICON_DIR, a);
  try {
    const type = readFileSync(`${file}.type`, "utf8");
    return { type, body: readFileSync(file) };
  } catch { /* not on disk yet */ }
  const missAt = iconMiss.get(a);
  if (missAt && Date.now() - missAt < NEG_ICON_TTL) return null;
  if (iconInflight.has(a)) return iconInflight.get(a);
  const job = (async () => {
    const meta = tokenMetaOf(a);
    const listed = cache.get("list")?.v?.all?.find((r) => r.token === a);
    const sources = [...new Set([ICON_SEED[a], iconCache.get(a)?.url, meta?.icon, listed?.icon, `https://dd.dexscreener.com/ds-data/tokens/robinhood/${a}.png?size=lg`].filter((u) => typeof u === "string" && /^https?:\/\//.test(u)))];
    for (const u of sources) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": UA["user-agent"], accept: "image/*" }, redirect: "follow" });
        const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
        if (!r.ok || !IMAGE_TYPES.test(type)) { try { await r.body?.cancel(); } catch { /* drained */ } continue; }
        const body = Buffer.from(await r.arrayBuffer());
        if (!body.length || body.length > 2_000_000) continue;
        try { mkdirSync(ICON_DIR, { recursive: true }); writeFileSync(file, body); writeFileSync(`${file}.type`, type); } catch { /* read-only data dir: memory only */ }
        if (!iconCache.get(a)?.url) { iconCache.set(a, { url: u, at: Date.now() }); persistIcons(); }
        return { type, body };
      } catch { /* next source */ }
    }
    iconMiss.set(a, Date.now());
    return null;
  })().finally(() => iconInflight.delete(a));
  iconInflight.set(a, job);
  return job;
}

// ----------------------------------------------------------------- pool

/** Live state of one pool plus its tokens, oriented so `base` is the token being LP'd. */
export async function poolState(pool, baseToken) {
  pool = lower(pool);
  if (isV4PoolId(pool)) return poolStateV4(pool, baseToken);
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
  // A pool the factory created but nobody initialised has no price yet; a
  // ladder cannot be aimed at a price that does not exist.
  if (BigInt(slot0[0]) === 0n) throw new Error("This pool exists but has never been initialised — it has no price yet, so nothing can be built in it.");
  const tick = Number(slot0[1]);
  const raw = tickToPrice(tick); // token1 per token0, raw units
  const scale = 10 ** (bInfo.decimals - qInfo.decimals);
  const price = base === info.token0 ? raw * scale : scale / raw; // quote per base, whole units
  const quoteUsd = quote === WETH ? usd : quote === USDG ? 1 : qInfo.usdPerToken;
  const priceUsd = quoteUsd ? price * quoteUsd : null;
  const supplyWhole = supply != null ? Number(supply) / 10 ** bInfo.decimals : null;
  // What the pool holds, in dollars: Delta's "Liquidity" figure.
  const heldBase = held[base === info.token0 ? 0 : 1], heldQuote = held[base === info.token0 ? 1 : 0];
  const tvlUsd = heldBase != null && heldQuote != null && priceUsd != null && quoteUsd != null
    ? (Number(heldBase) / 10 ** bInfo.decimals) * priceUsd + (Number(heldQuote) / 10 ** qInfo.decimals) * quoteUsd : null;
  return {
    pool, kind: "v3", venue: "v3", fee: info.fee, tickSpacing: Number(spacing), tick, sqrtPriceX96: slot0[0].toString(), liquidity: liquidity.toString(),
    token0: info.token0, token1: info.token1,
    base: { ...bInfo, isToken0: base === info.token0, totalSupply: supplyWhole }, quote: { ...qInfo, usdPerToken: quoteUsd },
    price, priceUsd, marketCapUsd: supplyWhole != null && priceUsd != null ? supplyWhole * priceUsd : null, tvlUsd,
  };
}

/**
 * The V4 twin. The pool's key comes from the Initialize event the watcher
 * recorded; price and liquidity from StateView. There is no per-pool balance
 * to read for TVL inside the singleton, so the liquidity profile within 10×
 * of the price is summed instead — for the pools this page shows, that is
 * where all of it sits anyway.
 */
async function poolStateV4(poolId, baseToken) {
  const key = poolKeyOf(STORE, poolId);
  if (!key) throw new Error("not a Uniswap V4 pool we know yet");
  const { token0, token1 } = tokensOf(key);
  const s = await v4Slot0(poolId);
  const base = lower(baseToken) === token1 ? token1 : token0;
  const quote = base === token0 ? token1 : token0;
  const [bInfo, qInfo, usd, supply, held] = await Promise.all([
    tokenInfo(base), tokenInfo(quote), ethUsd().catch(() => null),
    cached(`supply:${base}`, 3_600_000, async () => { const x = await call(base, ERC20_ABI, "totalSupply").catch(() => null); if (x == null) cache.delete(`supply:${base}`); return x; }),
    cachedSWR(`v4tvl:${poolId}`, 60_000, () => v4Holdings(poolId, key.tickSpacing, s.tick, s.liquidity)).catch(() => null),
  ]);
  const raw = tickToPrice(s.tick);
  const scale = 10 ** (bInfo.decimals - qInfo.decimals);
  const price = base === token0 ? raw * scale : scale / raw;
  const quoteUsd = quote === WETH ? usd : quote === USDG ? 1 : qInfo.usdPerToken;
  const priceUsd = quoteUsd ? price * quoteUsd : null;
  const supplyWhole = supply != null ? Number(supply) / 10 ** bInfo.decimals : null;
  const heldBase = held ? (base === token0 ? held.amount0 : held.amount1) : null, heldQuote = held ? (base === token0 ? held.amount1 : held.amount0) : null;
  const tvlUsd = heldBase != null && priceUsd != null && quoteUsd != null
    ? (Number(heldBase) / 10 ** bInfo.decimals) * priceUsd + (Number(heldQuote) / 10 ** qInfo.decimals) * quoteUsd : null;
  return {
    pool: poolId, kind: "v4", venue: "v4", poolId, key: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks },
    native0: key.native0, hooks: key.hooked ? key.hooks : null, dynamicFee: key.dynamicFee,
    fee: key.dynamicFee ? s.lpFee : key.fee, lpFee: s.lpFee, tickSpacing: key.tickSpacing, tick: s.tick, sqrtPriceX96: s.sqrtPriceX96.toString(), liquidity: s.liquidity.toString(),
    token0, token1,
    base: { ...bInfo, isToken0: base === token0, totalSupply: supplyWhole }, quote: { ...qInfo, usdPerToken: quoteUsd },
    price, priceUsd, marketCapUsd: supplyWhole != null && priceUsd != null ? supplyWhole * priceUsd : null, tvlUsd,
  };
}

async function tokenInfo(address) {
  const t = (await tradeTokens(STORE)).find((x) => x.address === address);
  return { address, symbol: address === WETH ? "ETH" : t?.symbol ?? address.slice(0, 8), name: t?.name ?? null, decimals: t?.decimals ?? 18, icon: t?.icon ?? iconFor(address), usdPerToken: t?.usdPerToken ?? null };
}

/** The token a pool is "about": whichever side is not ETH or USDG. */
async function baseOf(pool) {
  pool = lower(pool);
  let t0, t1;
  if (isV4PoolId(pool)) {
    const key = poolKeyOf(STORE, pool);
    if (!key) return undefined;
    ({ token0: t0, token1: t1 } = tokensOf(key));
  } else {
    const info = poolCache.get(pool);
    if (!info) return undefined;
    ({ token0: t0, token1: t1 } = info);
  }
  return isMoney(t0) && !isMoney(t1) ? t1 : t0;
}

/**
 * Every pool for a token against ETH or USDG, deepest first: the V3 pools
 * the resolver knows, then the V4 ETH pools the watcher has seen initialised.
 * V4 pools with a hook or a hook-set fee stay out — a hook may veto or tax
 * what the manager does, and the page cannot promise what it cannot see.
 */
export async function poolsForToken(token) {
  token = lower(token);
  // The other side must be ETH or USDG: the page quotes in money, never in another token.
  // The factory is asked directly, so a pool that has never traded is still offered.
  const seen = new Map(poolCache.cache.entries());
  for (const p of await factoryPoolsFor(token).catch(() => [])) seen.set(p.pool, p);
  const mine = [...seen.entries()].filter(([, p]) => p && !p.miss && p.v3 && (p.token0 === token || p.token1 === token) && isMoney(p.token0 === token ? p.token1 : p.token0));
  // Every V4 pool against ETH or USDG. A hooked or hook-priced pool comes along
  // as view-only: its market is real, but a hook may veto or tax what the manager
  // does, and the page cannot promise what it cannot see.
  const v4 = (STORE?.v4PoolsFor?.(token) ?? []).map((p) => poolKeyOf(STORE, p.poolId)).filter((k) => k && (k.native0 || lower(k.currency0) === USDG || lower(k.currency1) === USDG) && (lower(k.currency0) === token || lower(k.currency1) === token) && !isMoney(token));
  const [liq, slots, liq4, sqrt4, usd, info, ref] = await Promise.all([
    batchCall(mine.map(([addr]) => ({ to: addr, abi: POOL_ABI, fn: "liquidity" }))),
    batchCall(mine.map(([addr]) => ({ to: addr, abi: POOL_ABI, fn: "slot0" }))),
    v4.length ? v4LiquidityOf(v4.map((k) => k.poolId)) : [],
    v4.length ? sqrtPricesOf(v4.map((k) => k.poolId)) : [],
    ethUsd().catch(() => null),
    tokenInfo(token),
    // The token's price where it actually trades, from the ranked list (cached, so free).
    poolsList(STORE).then((l) => l.all.find((r) => r.token === token)?.priceUsd ?? null).catch(() => null),
  ]);
  // A pool whose liquidity could not be read must not rank as empty: the stake
  // page picks the deepest pool from this list, and a stake is created once per pool.
  if ([...liq, ...slots, ...liq4, ...sqrt4].some((x) => x == null)) throw new Error("The RPC did not answer for every pool; try again in a moment.");
  const quoteUsd = (quote) => (quote === WETH ? usd : 1);
  // Raw liquidity is not comparable across fee tiers or prices, so pools are ranked
  // by depth near the price, in ETH: the money a 10% move would pull out of the
  // liquidity active right now — L/√P·(1−1/√1.1) when the money is currency0,
  // L·√P·(1−√0.9) when it is currency1. Full-range arithmetic on active liquidity
  // would credit a tight position with a balance it does not hold. A pool with
  // less than a few dollars in reach is treated as empty — anyone can park dust
  // in a 10% pool, and it must not become the page's default over an unseeded 1% one.
  const depthOf = (L, sqrtPriceX96, quote, quoteIs0) => {
    const s = Number(sqrtPriceX96) / 2 ** 96;
    if (!(s > 0) || L === 0n) return 0;
    const q = quoteIs0 ? (Number(L) / s) * (1 - 1 / Math.sqrt(1.1)) : Number(L) * s * (1 - Math.sqrt(0.9));
    return quote === WETH ? q / 1e18 : usd ? q / 1e6 / usd : q / 1e6 / 4000;
  };
  // The pool's own price in USD per token, from its sqrtPrice and the two decimals.
  const priceUsdOf = (sqrtPriceX96, quote, quoteIs0) => {
    const s = Number(sqrtPriceX96) / 2 ** 96;
    if (!(s > 0) || !quoteUsd(quote)) return null;
    const raw = s * s, scale = 10 ** (info.decimals - (quote === WETH ? 18 : 6));
    return (quoteIs0 ? scale / raw : raw * scale) * quoteUsd(quote);
  };
  // A pool priced far from where the token trades is not a market: a position
  // built there at its price is a gift to the first arbitrageur. It ranks as
  // empty and is flagged, so the page can say so instead of offering it.
  const offMarket = (priceUsd) => ref != null && priceUsd != null && Math.abs(Math.log(priceUsd / ref)) > Math.log(3);
  const DUST_ETH = 0.005;
  const live = (p) => p.depthEth >= DUST_ETH && !p.offMarket;
  // With nothing live the tier a new market should start at comes first: 1% for
  // a volatile token, then the other standard tiers; a made-up tier last.
  const tierRank = (fee) => { const i = [10000, 3000, 500, 100].indexOf(fee); return i < 0 ? 4 + Math.abs(Math.log((fee || 1) / 10000)) : i; };
  const byDepth = (a, b) => (live(a) !== live(b) ? (live(a) ? -1 : 1) : live(a) ? b.depthEth - a.depthEth : tierRank(a.fee) - tierRank(b.fee));
  // Anyone can initialise a V4 pool for a few cents, so a token collects dozens
  // of empty ones at absurd fee tiers. Offer the ones holding liquidity (at most
  // eight); with none live, the sanest three so the first position can still be built.
  // A fee above 10% is a trap, not a market (V4 lets anyone set 93%); dust parked in one
  // does not make it worth offering.
  const v4Quote = (k) => { const { token0, token1 } = tokensOf(k); return token0 === token ? token1 : token0; };
  // A zero-fee pool pays LPs nothing; a hook-set fee is unknown here and reported as null.
  const v4Rows = v4.map((k, i) => {
    const quote = v4Quote(k), quoteIs0 = lower(k.currency0) !== token, priceUsd = priceUsdOf(sqrt4[i], quote, quoteIs0);
    return { pool: k.poolId, kind: "v4", venue: "v4", fee: k.dynamicFee ? null : k.fee, tickSpacing: k.tickSpacing, quote, liquidity: liq4[i].toString(), depthEth: depthOf(liq4[i], sqrt4[i], quote, quoteIs0), priceUsd, offMarket: offMarket(priceUsd), buildable: isPlainMoneyPool(k, USDG) && !offMarket(priceUsd), hooked: k.hooked, dynamicFee: k.dynamicFee };
  }).filter((p) => p.fee == null || (p.fee > 0 && p.fee <= 100_000)).sort(byDepth);
  // Per quote asset: the live ones (at most eight), then up to three empty ones
  // at the sanest fees, so a tier nobody has seeded can still be the first.
  const v4Shown = [];
  for (const q of [WETH, USDG]) {
    const rows = v4Rows.filter((p) => p.quote === q);
    v4Shown.push(...rows.filter(live).slice(0, 8), ...rows.filter((p) => !live(p)).slice(0, 3));
  }
  const rows = [
    ...mine.map(([addr, p], i) => {
      const quote = p.token0 === token ? p.token1 : p.token0, quoteIs0 = p.token0 !== token, priceUsd = priceUsdOf(slots[i][0], quote, quoteIs0);
      return { pool: addr, kind: "v3", venue: "v3", fee: p.fee, tickSpacing: null, quote, liquidity: liq[i].toString(), depthEth: depthOf(liq[i], slots[i][0], quote, quoteIs0), priceUsd, offMarket: offMarket(priceUsd), buildable: !offMarket(priceUsd), hooked: false, dynamicFee: false };
    }),
    ...v4Shown,
  ];
  return rows
    .map((p) => ({ ...p, quoteSymbol: p.quote === WETH ? "ETH" : "USDG" }))
    .sort(byDepth);
}
/**
 * Creating a pool that does not exist yet: a plain V4 pool of native ETH and
 * the token at the chosen fee tier, opened at the price the token already
 * trades at (its busiest market, whatever venue or hook that has), or at a
 * price the caller names when nothing trades. Costs gas only; the first
 * position is placed afterwards from the same page.
 */
export async function poolCreatePlan({ token, fee, price = null }) {
  token = lower(token);
  if (isMoney(token)) throw new Error("ETH and USDG are the quote side, not a pool to create");
  fee = Number(fee);
  const tickSpacing = SPACING_FOR_FEE[fee];
  if (!tickSpacing) throw new Error("fee tier must be 0.01%, 0.05%, 0.3% or 1%");
  const existing = (STORE?.v4PoolsFor?.(token) ?? []).map((p) => poolKeyOf(STORE, p.poolId))
    .find((k) => k && k.native0 && !k.hooked && k.fee === fee && k.tickSpacing === tickSpacing);
  if (existing) throw new Error(`An ETH pool at ${(fee / 1e4).toFixed(2)}% already exists for this token.`);
  const info = await tokenInfo(token);
  // Where the price comes from: the caller, else the token's busiest market.
  let ethPerToken = price != null ? Number(price) : null, source = price != null ? "given" : null, liveSqrt = null;
  const usd = await ethUsd().catch(() => null);
  if (ethPerToken == null) {
    const row = (await poolsList(STORE)).all.find((r) => r.token === token);
    if (row?.priceUsd && usd) {
      ethPerToken = row.priceUsd / usd;
      source = `${info.symbol}/${row.quote}${row.kind === "v4" ? " V4" : " V3"}, the busiest market`;
      // That market's own V4 ETH pool: copy its sqrtPrice as it stands this block — exact,
      // and current to the second, where the candle-derived figure can trail a few percent.
      if (row.kind === "v4" && poolKeyOf(STORE, row.pool)?.native0) {
        const s = await v4Slot0(row.pool).catch(() => null);
        if (s) {
          liveSqrt = BigInt(s.sqrtPriceX96);
          ethPerToken = 10 ** (info.decimals - 18) / (Number(liveSqrt) / 2 ** 96) ** 2;
          source += ", live";
        }
      }
    }
  }
  if (!(ethPerToken > 0)) throw new Error("This token has no market to take a starting price from; enter one.");
  // token1 (the token) per token0 (ETH), raw units: 10^(dToken−18) / (ETH per token).
  const raw = 10 ** (info.decimals - 18) / ethPerToken;
  const { key, sqrtPriceX96, data } = initializeCalldata(token, fee, raw, liveSqrt);
  return {
    token, symbol: info.symbol, fee, tickSpacing, key, sqrtPriceX96: sqrtPriceX96.toString(),
    price: ethPerToken, priceUsd: usd ? ethPerToken * usd : null, priceSource: source,
    tx: { to: getAddress(V4.poolManager), data, value: "0" },
  };
}

// ---------------------------------------------------------------- depth

/**
 * Where the liquidity is. Reads the tick bitmap around the price, then the
 * net liquidity at every initialised tick, and walks outward from the current
 * active liquidity to rebuild the depth profile. Bucketed for the chart.
 */
export async function poolDepth(pool, { spanTicks = 3000, buckets = 60, base = null } = {}) {
  pool = lower(pool);
  return cached(`depth:${pool}:${base ?? ""}:${spanTicks}:${buckets}`, 30_000, async () => {
    // Oriented to the token being LP'd, else the pool's non-money side, so the dollar
    // figures use the ETH/USDG price rather than whatever the token's own quote happens to be.
    const st = await poolState(pool, base ?? await baseOf(pool));
    const spacing = st.tickSpacing;
    const lo = alignTick(st.tick - spanTicks, spacing, "down");
    const hi = alignTick(st.tick + spanTicks, spacing, "up");
    const { initialised, netAt } = st.kind === "v4" ? await v4TickProfile(pool, spacing, lo, hi) : await v3TickProfile(pool, spacing, lo, hi);

    // Active liquidity per tick, walking up and down from the current tick.
    const segs = segmentsOf({ tick: st.tick, liquidity: st.liquidity, initialised, netAt }, lo, hi); // [from, to, L]

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
      const price = st.base.isToken0 ? rawMid * sc : sc / rawMid;
      bars.push({ tickLower: Math.round(a), tickUpper: Math.round(b), price, liquidity: avg.toString(), usd });
    }
    return { pool, kind: st.kind, tick: st.tick, price: st.price, priceUsd: st.priceUsd, bars, initialisedTicks: initialised.length };
  });
}

/** The initialised ticks in [lo, hi] and the net liquidity at each, read off a V3 pool's own bitmap. */
async function v3TickProfile(pool, spacing, lo, hi) {
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
  return { initialised, netAt: new Map(initialised.map((t, i) => [t, nets[i] ? BigInt(nets[i][1]) : 0n])) };
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
  const toTick = (p) => priceToTick(st.base.isToken0 ? p / sc : sc / p);
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
  // The V4 manager takes the pool's key where V3's takes its address; the rest of the call is the same.
  const poolArg = st.kind === "v4" ? keyArg(st.key) : getAddress(st.pool);
  const abi = venueFor(st.kind).abi;
  const build = (signed) => signed
    ? encodeFunctionData({ abi, functionName: "openLadderWithPermit", args: [poolArg, rungs, shapeCode(shape), st.tick - band, st.tick + band, BigInt(deadline), signed] })
    : encodeFunctionData({ abi, functionName: "openLadder", args: [poolArg, rungs, shapeCode(shape), st.tick - band, st.tick + band, BigInt(deadline)] });
  const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : sc / raw; };
  return {
    pool: st.pool, kind: st.kind, venue: st.kind, tick: st.tick, price: st.price, priceUsd: st.priceUsd,
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

/**
 * How a deposit is paid: the ETH side as native value, every ERC-20 side by
 * allowance — or the token being LP'd by permit when the caller signed one.
 * The V3 manager wraps the value into WETH itself; the V4 manager settles it
 * as the pool's native currency. Either way the wallet sends ETH.
 */
async function fundingFor(st, total0, total1, build, deadline, owner, permit) {
  const manager = getAddress(venueFor(st.kind).manager);
  const wethIsToken0 = st.token0 === WETH;
  const wethNeeded = st.token0 === WETH ? total0 : st.token1 === WETH ? total1 : 0n;
  // Every ERC-20 side with something to pay, the token being LP'd first: that is the one a permit can cover.
  const sides = [[st.token0, total0], [st.token1, total1]].filter(([t, n]) => t !== WETH && n > 0n).sort(([a], [b]) => (a === st.base.address ? -1 : b === st.base.address ? 1 : 0));
  const [other, otherNeeded] = sides[0] ?? [null, 0n];
  const needsToken = otherNeeded > 0n;
  const info = needsToken ? await permitInfo(other, owner).catch(() => ({ supported: false })) : { supported: false };
  const signed = needsToken && permit && info.supported ? { token: getAddress(other), value: permit.value, deadline: permit.deadline, v: permit.v, r: permit.r, s: permit.s } : null;
  // With a signed permit no approve transaction is needed for that side; the signature rides in the calldata.
  const approvals = sides.filter(([t]) => !(signed && t === other)).map(([t, n]) => ({ token: getAddress(t), amount: n.toString(), spender: manager }));
  return {
    to: manager, venue: st.kind, data: build(signed),
    value: wethNeeded.toString(),
    approve: approvals[0] ?? null,
    approvals,
    permit: needsToken ? { ...info, spender: manager, value: otherNeeded.toString(), deadline, applied: !!signed } : null,
    wethIsToken0, deadline,
  };
}

/**
 * Top up an open ladder. The bins are the ones already open — same ticks, so
 * the contract deepens each position rather than minting new ones — and the
 * shape is whatever the user picks for the amount being added.
 */
export async function planAdd({ id, venue = "v3", shape = "spot", baseAmount = 0n, quoteAmount = 0n, owner = null, permit = null }) {
  const v = venueFor(venue);
  const l = await call(v.manager, v.abi, "ladder", [BigInt(id)]);
  if (l.closedAt !== 0n) throw new Error("ladder is closed");
  const poolKey = v.poolOf(l);
  const st = await poolState(poolKey, await baseOf(poolKey));
  const open = l.bins.filter((b) => b.open).map((b) => ({ tickLower: Number(b.tickLower), tickUpper: Number(b.tickUpper) })).sort((a, b) => a.tickLower - b.tickLower);
  const budget0 = st.base.isToken0 ? baseAmount : quoteAmount;
  const budget1 = st.base.isToken0 ? quoteAmount : baseAmount;
  const rs = allocateRungs(open, st.tick, shape, budget0, budget1);
  const total0 = rs.reduce((n, r) => n + r.amount0, 0n), total1 = rs.reduce((n, r) => n + r.amount1, 0n);
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const rungs = rs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, amount0: r.amount0, amount1: r.amount1, amount0Min: 0n, amount1Min: 0n }));
  const build = (signed) => signed
    ? encodeFunctionData({ abi: v.abi, functionName: "addLiquidityWithPermit", args: [BigInt(id), rungs, BigInt(deadline), signed] })
    : encodeFunctionData({ abi: v.abi, functionName: "addLiquidity", args: [BigInt(id), rungs, BigInt(deadline)] });
  const sc = 10 ** (st.base.decimals - st.quote.decimals);
  const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : sc / raw; };
  return {
    id: String(id), venue: v.id, pool: st.pool, kind: st.kind, tick: st.tick, price: st.price, priceUsd: st.priceUsd, base: st.base, quote: st.quote, shape,
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
  // The deepest V3 pool for the pair, or failing that the deepest plain V4 one: a token that only trades in V4 still has a tape.
  const tapePool = async (base, quote) => (await bestPool(base, quote)) ?? (await bestPoolV4(STORE, base, quote).catch(() => null));
  const closeAt = async (base, quote) => {
    const found = await tapePool(base === "eth" ? WETH : base, quote === "eth" ? WETH : quote);
    const cov = found && STORE?.candleCoverage?.(found.pool);
    if (!cov || cov.from > ts) return null;
    const c = await tradeCandles({ base, quote, pool: found.kind === "v4" ? found.pool : null, bucketSec, hours, store: STORE });
    let last = null;
    for (const x of c.candles) { if (x.time <= ts) last = x; else break; }
    return last?.close ?? null;
  };
  let usd = null;
  try {
    if (token === WETH) usd = await closeAt("eth", USDG);
    else if (await tapePool(token, WETH)) { const inEth = await closeAt(token, "eth"); const eth = await usdAt(WETH, ts); usd = inEth != null && eth != null ? inEth * eth : null; }
    else if (await tapePool(token, USDG)) usd = await closeAt(token, USDG);
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

async function ownerLogs(owner, venue) {
  const key = `${venue.id}:${owner}`;
  const cur = logCache.get(key) ?? { toBlock: venue.deployBlock - 1, logs: [] };
  const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
  let from = cur.toBlock + 1;
  let span = 400_000;
  while (from <= head) {
    const to = Math.min(head, from + span - 1);
    try {
      const part = await archiveFetch("eth_getLogs", [{ address: venue.manager, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [venue.topics, null, pad32(owner)] }]);
      cur.logs.push(...part);
      from = to + 1;
    } catch (e) {
      if (span <= 2_000) throw e;
      span = Math.floor(span / 4);
    }
  }
  cur.toBlock = head;
  logCache.set(key, cur);
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
async function historyOf(owner, venue) {
  const logs = await ownerLogs(owner, venue);
  const byLadder = new Map();
  const txs = new Map(); // hash → { ts, gasEth, events: [], npm: Map(tokenId → flows), deltas: Map(tokenId → liquidity delta) }
  for (const lg of logs) {
    let ev;
    try { ev = decodeEventLog({ abi: venue.abi, data: lg.data, topics: lg.topics }); } catch { continue; }
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
    tx.deltas = new Map();
    for (const lg of r?.logs ?? []) {
      if (venue.id === "v3") {
        // The V3 position manager says what each bin took and gave, in token amounts.
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
      } else {
        // The V4 singleton says only how much liquidity each bin gained or lost;
        // amounts are reconstructed per ladder, where the pool's price is known.
        if (lower(lg.address) !== V4.poolManager || lg.topics[0] !== MODIFY_LIQUIDITY_TOPIC) continue;
        try {
          const ev = decodeEventLog({ abi: [MODIFY_LIQUIDITY_EVENT], data: lg.data, topics: lg.topics });
          if (lower(ev.args.sender) !== V4.positionManager) continue;
          const tid = BigInt(ev.args.salt).toString();
          tx.deltas.set(tid, (tx.deltas.get(tid) ?? 0n) + ev.args.liquidityDelta);
        } catch { /* not ours */ }
      }
    }
  }));
  return { byLadder, txs };
}

/**
 * V4 bins' token flows from their liquidity deltas: each bin's amounts at the
 * price the tape recorded for that minute, scaled so the bins of a deposit sum
 * to exactly what the manager said went in. Without tape for that minute the
 * current price stands in; the totals are still exact, only the split between
 * bins is then approximate.
 */
async function flowsFromDeltas(tx, l, st, in0, in1, out0, out1) {
  const flows = new Map();
  const mine = [...tx.deltas].filter(([tid]) => l.bins.some((b) => b.tokenId.toString() === tid));
  if (!mine.length) return flows;
  const tick = (await tickAt(st.pool, tx.ts)) ?? st.tick;
  const sqrtP = tickToSqrtPriceX96(tick);
  const rawOf = (tid, dL) => {
    const b = l.bins.find((x) => x.tokenId.toString() === tid);
    return amountsForLiquidity(sqrtP, tickToSqrtPriceX96(Number(b.tickLower)), tickToSqrtPriceX96(Number(b.tickUpper)), dL < 0n ? -dL : dL);
  };
  const scaleTo = (rows, total0, total1) => {
    const s0 = rows.reduce((n, r) => n + r.amount0, 0n), s1 = rows.reduce((n, r) => n + r.amount1, 0n);
    return rows.map((r) => ({ tid: r.tid, amount0: s0 > 0n ? (r.amount0 * total0) / s0 : 0n, amount1: s1 > 0n ? (r.amount1 * total1) / s1 : 0n }));
  };
  const inc = mine.filter(([, d]) => d > 0n).map(([tid, d]) => ({ tid, ...rawOf(tid, d) }));
  const dec = mine.filter(([, d]) => d < 0n).map(([tid, d]) => ({ tid, ...rawOf(tid, d) }));
  for (const r of scaleTo(inc, in0, in1)) flows.set(r.tid, { ...(flows.get(r.tid) ?? { inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n }), inc0: r.amount0, inc1: r.amount1 });
  for (const r of scaleTo(dec, out0, out1)) flows.set(r.tid, { ...(flows.get(r.tid) ?? { inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n }), dec0: r.amount0, dec1: r.amount1, closed: true });
  return flows;
}

/** The pool's tick at a moment in the past, from our own minute candles; null when the tape does not reach it. */
async function tickAt(pool, ts) {
  const cov = STORE?.candleCoverage?.(pool);
  if (!cov || cov.from > ts) return null;
  const rows = STORE?.candlesFor?.(pool, Math.floor(ts / 60) * 60 - 6 * 3600) ?? [];
  let last = null;
  for (const c of rows) { if (c.bucket <= ts) last = c; else break; }
  if (!last || !(last.close > 0)) return null;
  return Math.floor(Math.log(last.close) / Math.log(1.0001));
}

/**
 * Every ladder a wallet holds or held: live value, claimable fees, what went
 * in and came out at the prices of the day, gas, and the realised PnL that
 * each close landed on its day — the same accounting a broker statement uses.
 */
export async function positionsOf(store, owner) {
  owner = getAddress(owner);
  return cached(`portfolio:${owner}`, 8_000, async () => {
    const [v3, v4] = await Promise.all([buildPortfolio(owner, V3_VENUE), buildPortfolio(owner, V4_VENUE)]);
    return mergePortfolios(owner, [v3, v4]);
  });
}

/** Both managers' ladders as one statement: cards interleave by age, the calendar and the totals add up. */
function mergePortfolios(owner, parts) {
  const ladders = parts.flatMap((p) => p.ladders).sort((a, b) => b.openedAt - a.openedAt);
  const days = {};
  for (const p of parts) for (const [d, row] of Object.entries(p.days)) {
    const cur = days[d] ?? (days[d] = { pnlUsd: 0, pnlEth: 0, gasUsd: 0, closes: 0, collects: 0 });
    for (const k of Object.keys(cur)) cur[k] += row[k] ?? 0;
  }
  const totals = parts.reduce((t, p) => { for (const k of Object.keys(t)) t[k] += p.totals[k] ?? 0; return t; }, { valueUsd: 0, unclaimedUsd: 0, claimedUsd: 0, depositedUsd: 0, pnlUsd: 0, gasUsd: 0, open: 0, closed: 0 });
  return {
    owner, manager: LADDER_MANAGER, managers: { v3: LADDER_MANAGER, v4: LADDER_MANAGER_V4 }, ethUsd: parts.find((p) => p.ethUsd != null)?.ethUsd ?? null,
    ladders, days, totals, historyError: parts.map((p) => p.historyError).filter(Boolean).join("; ") || null,
  };
}

async function buildPortfolio(owner, venue) {
  const ids = await call(venue.manager, venue.abi, "laddersOf", [owner]).catch((e) => { console.warn(`pools | ${venue.id} laddersOf ${owner} failed: ${e?.message ?? e}`); return []; });
  const usd = await ethUsd().catch(() => null);
  const empty = { owner, venue: venue.id, manager: venue.manager, ethUsd: usd, ladders: [], days: {}, totals: { valueUsd: 0, unclaimedUsd: 0, claimedUsd: 0, depositedUsd: 0, pnlUsd: 0, gasUsd: 0, open: 0, closed: 0 }, historyError: null };
  if (!ids.length) return empty;
  let historyError = null;
  const [ladders, hist] = await Promise.all([
    batchCall(ids.map((id) => ({ to: venue.manager, abi: venue.abi, fn: "ladder", args: [id] }))),
    historyOf(owner, venue).catch((e) => { historyError = e?.message ?? String(e); console.warn(`pools | ${venue.id} history for ${owner} unavailable: ${historyError}`); return { byLadder: new Map(), txs: new Map() }; }),
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
    const poolKey = venue.poolOf(l);
    const st = await poolState(poolKey, await baseOf(poolKey)).catch(() => null);
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
    const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : sc / raw; };

    // Live holdings per bin.
    const openBins = l.bins.map((b, k) => ({ ...b, index: k })).filter((b) => b.open);
    const posRaw = openBins.length ? await venue.binLiquidity(openBins) : [];
    const sqrtP = tickToSqrtPriceX96(st.tick);
    let held0 = 0n, held1 = 0n;
    const liveByIndex = new Map();
    posRaw.forEach((p, k) => {
      if (!p || p.liquidity == null) return;
      const a = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(p.tickLower), tickToSqrtPriceX96(p.tickUpper), p.liquidity);
      held0 += a.amount0; held1 += a.amount1;
      liveByIndex.set(openBins[k].index, { liquidity: p.liquidity.toString(), amount0: a.amount0, amount1: a.amount1 });
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
      try { const [f0, f1] = await call(venue.manager, venue.abi, "collect", [ids[i]], owner); fee0 = BigInt(f0); fee1 = BigInt(f1); } catch { /* nothing accrued */ }
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
      if (venue.id === "v4" && tx.deltas?.size) {
        // Per-bin amounts from the singleton's liquidity deltas, pinned to the manager's own totals.
        const inA = opened ? [opened.args.deposited0, opened.args.deposited1] : added ? [added.args.added0, added.args.added1] : [0n, 0n];
        const outA = closed ? [closed.args.principal0, closed.args.principal1] : [0n, 0n];
        const flows = await flowsFromDeltas(tx, l, st, inA[0], inA[1], outA[0], outA[1]);
        tx.npm = new Map([...tx.npm, ...flows]);
      }
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
        for (const [tid, f] of tx.npm) { if (myTokenIds.has(tid) && (f.closed || f.dec0 || f.dec1 || (!f.inc0 && !f.inc1 && (f.col0 || f.col1)))) { closedCost += cost.get(tid) ?? 0; cost.delete(tid); } }
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
      id, venue: venue.id, manager: venue.manager, pool: poolKey, kind: st.kind, fee: st.fee, tickSpacing: st.tickSpacing, closed: !isOpen, openedAt, closedAt: closedAt || null,
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
  return { owner, venue: venue.id, manager: venue.manager, ethUsd: usd, ladders: out.sort((a, b) => b.openedAt - a.openedAt), days, totals, historyError };
}

// ------------------------------------------------------------ platform

const FEES_TOPIC = toEventSelector(LADDER_ABI.find((x) => x.type === "event" && x.name === "FeesCollected"));
const feeLogCache = new Map(); // venue id → { toBlock, logs }
/** Every FeesCollected a manager ever emitted, for every owner, read incrementally. */
async function allFeeLogs(venue) {
  const cur = feeLogCache.get(venue.id) ?? { toBlock: venue.deployBlock - 1, logs: [] };
  const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
  let from = cur.toBlock + 1, span = 400_000;
  while (from <= head) {
    const to = Math.min(head, from + span - 1);
    try {
      const part = await archiveFetch("eth_getLogs", [{ address: venue.manager, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [FEES_TOPIC] }]);
      cur.logs.push(...part);
      from = to + 1;
    } catch (e) {
      if (span <= 2_000) throw e;
      span = Math.floor(span / 4);
    }
  }
  cur.toBlock = head;
  feeLogCache.set(venue.id, cur);
  return cur.logs;
}

/**
 * The numbers in the header of every liquidity page — the same four Delta
 * shows: positions ever built, fees earned by LPs (owner share plus the 1%,
 * each valued the day it was collected), what is in open positions now, and
 * the ETH price. Both managers count; stakes are folded in by the caller,
 * which knows them.
 */
export async function platformStats({ stakesTvlUsd = 0, stakesFeesUsd = 0, stakes = 0 } = {}) {
  return cached("platform", 60_000, async () => {
    const [usd, ...venues] = await Promise.all([ethUsd().catch(() => null), venueStats(V3_VENUE), venueStats(V4_VENUE)]);
    const sum = (k) => venues.reduce((n, v) => n + v[k], 0);
    const ladderFeesUsd = sum("feesUsd"), ladderTvlUsd = sum("tvlUsd");
    return {
      totalPositions: sum("count"), openPositions: sum("open"), stakes,
      byVenue: Object.fromEntries(venues.map((v) => [v.venue, v])),
      totalFeesUsd: ladderFeesUsd + stakesFeesUsd, ladderFeesUsd, stakesFeesUsd,
      tvlUsd: ladderTvlUsd + stakesTvlUsd, ladderTvlUsd, stakesTvlUsd,
      ethUsd: usd, at: new Date().toISOString(),
    };
  });
}

async function venueStats(venue) {
  const countRaw = await call(venue.manager, venue.abi, "ladderCount").catch(() => 0n);
  const count = Number(countRaw);
  const ids = Array.from({ length: count }, (_, i) => BigInt(i));
  const ladders = count ? await batchCall(ids.map((id) => ({ to: venue.manager, abi: venue.abi, fn: "ladder", args: [id] }))) : [];
  const byId = new Map(ladders.map((l, i) => [String(i), l]).filter(([, l]) => l));

  // Open value: every live bin, priced at the pool's current tick.
  const openBins = [];
  for (const l of ladders) { if (!l || l.closedAt !== 0n) continue; for (const b of l.bins) if (b.open) openBins.push({ tokenId: b.tokenId, tickLower: b.tickLower, tickUpper: b.tickUpper, pool: venue.poolOf(l) }); }
  const states = new Map();
  for (const p of new Set(openBins.map((b) => b.pool))) states.set(p, await poolState(p, await baseOf(p)).catch(() => null));
  const valNow = (st, a0, a1) => {
    const d0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals), d1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
    const p0 = st.base.isToken0 ? st.priceUsd : st.quote.usdPerToken, p1 = st.base.isToken0 ? st.quote.usdPerToken : st.priceUsd;
    return (Number(a0) / d0) * (p0 ?? 0) + (Number(a1) / d1) * (p1 ?? 0);
  };
  let tvlUsd = 0;
  const pos = openBins.length ? await venue.binLiquidity(openBins) : [];
  pos.forEach((p, i) => {
    const st = states.get(openBins[i].pool); if (!p || p.liquidity == null || !st) return;
    const a = amountsForLiquidity(tickToSqrtPriceX96(st.tick), tickToSqrtPriceX96(p.tickLower), tickToSqrtPriceX96(p.tickUpper), p.liquidity);
    tvlUsd += valNow(st, a.amount0, a.amount1);
  });

  // Fees ever collected, owner share plus treasury, at the price of the day.
  let feesUsd = 0;
  try {
    const logs = await allFeeLogs(venue);
    for (const lg of logs) {
      let ev; try { ev = decodeEventLog({ abi: venue.abi, data: lg.data, topics: lg.topics }); } catch { continue; }
      const l = byId.get(ev.args.ladderId.toString()); if (!l) continue;
      const pool = venue.poolOf(l);
      if (!states.has(pool)) states.set(pool, await poolState(pool, await baseOf(pool)).catch(() => null));
      const st = states.get(pool); if (!st) continue;
      const ts = await blockTs(lg.blockNumber);
      const [u0, u1] = await Promise.all([usdAt(st.token0, ts), usdAt(st.token1, ts)]);
      const d0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals), d1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
      feesUsd += (Number(ev.args.toOwner0 + ev.args.toTreasury0) / d0) * (u0 ?? 0) + (Number(ev.args.toOwner1 + ev.args.toTreasury1) / d1) * (u1 ?? 0);
    }
  } catch (e) { console.warn(`pools | ${venue.id} platform fees unavailable: ${e?.message ?? e}`); }

  return { venue: venue.id, manager: venue.manager, count, open: ladders.filter((l) => l && l.closedAt === 0n).length, tvlUsd, feesUsd };
}

const mgr = (venue) => getAddress(venueFor(venue).manager);
const abiOf = (venue) => venueFor(venue).abi;
export const collectCalldata = (id, venue = "v3") => ({ to: mgr(venue), venue: venueFor(venue).id, data: encodeFunctionData({ abi: abiOf(venue), functionName: "collect", args: [BigInt(id)] }) });
export const closeCalldata = (id, venue = "v3") => ({ to: mgr(venue), venue: venueFor(venue).id, data: encodeFunctionData({ abi: abiOf(venue), functionName: "close", args: [BigInt(id)] }) });
export const closeBinsCalldata = (id, indices, venue = "v3") => ({ to: mgr(venue), venue: venueFor(venue).id, data: encodeFunctionData({ abi: abiOf(venue), functionName: "closeBins", args: [BigInt(id), indices.map((i) => BigInt(i))] }) });
export const closeManyCalldata = (ids, venue = "v3") => ({ to: mgr(venue), venue: venueFor(venue).id, data: encodeFunctionData({ abi: abiOf(venue), functionName: "closeMany", args: [ids.map((i) => BigInt(i))] }) });
