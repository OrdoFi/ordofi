import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
import { rpcFetch, rpcUrls, RPC_HEADERS } from "@ordofi/core";
import { ethUsd } from "@ordofi/core/pricing";
import {
  alignTick,
  amountsForLiquidity,
  planLadder,
  priceToTick,
  tickToPrice,
  tickToSqrtPriceX96,
} from "@ordofi/core/liquidity";
import { CHAIN, USDG, WETH, poolCache, tradeCandles, tradeMarkets, tradeTokens } from "./trade.mjs";

/**
 * Liquidity provision on Uniswap V3 pools, the way a person would want to do
 * it: pick a token, see where liquidity sits, drag a range, choose a shape,
 * and mint the whole ladder in one transaction through OrdoLadderManager.
 *
 * This module is the read side and the planner. It never signs anything; it
 * turns "I want a curve from $2,300 to $2,600 with 1 ETH" into the exact rungs
 * the contract will mint, and it reads back what a wallet already holds.
 */

export const LADDER_MANAGER = process.env.ORDO_LADDER_ADDRESS ?? "0xa89Ffd22477B3937C934E5A6A943d9b2aAd33A98";
const NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const NATIVE = "eth";

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
export const LADDER_ABI = [
  {
    type: "function", name: "mintLadder", stateMutability: "payable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "rungs", type: "tuple[]", components: [
        { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
        { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" },
        { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      ] },
      { name: "minTick", type: "int24" }, { name: "maxTick", type: "int24" }, { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "close", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "laddersOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] },
  {
    type: "function", name: "ladder", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "pool", type: "address" }, { name: "mintedAt", type: "uint64" },
      { name: "deposited0", type: "uint256" }, { name: "deposited1", type: "uint256" },
      { name: "collected0", type: "uint256" }, { name: "collected1", type: "uint256" },
      { name: "tokenIds", type: "uint256[]" }, { name: "closed", type: "bool" },
    ] }],
  },
];
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
  return cached("list", 20_000, async () => {
    const [markets, tokens] = await Promise.all([tradeMarkets(store), tradeTokens(store)]);
    const tokenBy = new Map(tokens.map((t) => [t.address, t]));
    const byToken = new Map();
    for (const m of markets.markets ?? []) {
      const baseAddr = m.base.address === NATIVE ? WETH : m.base.address;
      if (isMoney(baseAddr)) continue;
      const info = poolCache.get(m.pool);
      const feeBps = info?.fee ? info.fee / 1e4 : 0.3; // fee tier in percent
      const cur = byToken.get(baseAddr);
      const row = {
        token: baseAddr,
        symbol: m.base.symbol,
        name: tokenBy.get(baseAddr)?.name ?? null,
        icon: m.base.icon ?? tokenBy.get(baseAddr)?.icon ?? null,
        decimals: m.base.decimals,
        priceUsd: m.base.usdPerToken ?? (m.quote.usdPerToken ? m.price * m.quote.usdPerToken : null),
        change24: m.change24,
        volume24Usd: m.volumeUsd ?? 0,
        fees24Usd: (m.volumeUsd ?? 0) * (feeBps / 100),
        trades24: m.swaps,
        pool: m.pool,
        quote: m.quote.symbol,
        pools: 1,
      };
      if (!cur) byToken.set(baseAddr, row);
      else {
        cur.volume24Usd += row.volume24Usd; cur.fees24Usd += row.fees24Usd; cur.trades24 += row.trades24; cur.pools++;
        if (row.volume24Usd > (cur.mainVol ?? 0)) { cur.pool = row.pool; cur.quote = row.quote; cur.mainVol = row.volume24Usd; }
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
    const trending = rows.slice().sort((a, b) => b.volume24Usd - a.volume24Usd).slice(0, 40);
    const established = rows.filter((r) => r.marketCapUsd).sort((a, b) => b.marketCapUsd - a.marketCapUsd).slice(0, 40);
    const totals = { volume24Usd: rows.reduce((n, r) => n + r.volume24Usd, 0), fees24Usd: rows.reduce((n, r) => n + r.fees24Usd, 0), tokens: rows.length };
    return { trending, established, totals, manager: LADDER_MANAGER, at: new Date().toISOString() };
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
  const [bInfo, qInfo, usd] = await Promise.all([tokenInfo(base), tokenInfo(quote), ethUsd().catch(() => null)]);
  const tick = Number(slot0[1]);
  const raw = tickToPrice(tick); // token1 per token0, raw units
  const scale = 10 ** (bInfo.decimals - qInfo.decimals);
  const price = base === info.token0 ? raw * scale : 1 / (raw * scale); // quote per base, whole units
  const quoteUsd = quote === WETH ? usd : quote === USDG ? 1 : qInfo.usdPerToken;
  return {
    pool, fee: info.fee, tickSpacing: Number(spacing), tick, sqrtPriceX96: slot0[0].toString(), liquidity: liquidity.toString(),
    token0: info.token0, token1: info.token1,
    base: { ...bInfo, isToken0: base === info.token0 }, quote: { ...qInfo, usdPerToken: quoteUsd },
    price, priceUsd: quoteUsd ? price * quoteUsd : null,
  };
}

async function tokenInfo(address) {
  const t = (await tradeTokens(STORE)).find((x) => x.address === address);
  return { address, symbol: address === WETH ? "ETH" : t?.symbol ?? address.slice(0, 8), name: t?.name ?? null, decimals: t?.decimals ?? 18, icon: t?.icon ?? null, usdPerToken: t?.usdPerToken ?? null };
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
export async function planPosition({ pool, base, minPrice, maxPrice, shape = "curve", bins = 10, baseAmount = 0n, quoteAmount = 0n, slippageBps = 100 }) {
  const st = await poolState(pool, base);
  const sc = 10 ** (st.base.decimals - st.quote.decimals);
  // Back to raw token1/token0 ticks. For an inverted pool a higher quote price is a lower tick.
  const toTick = (p) => priceToTick(st.base.isToken0 ? p / sc : 1 / (p * sc));
  const tA = toTick(minPrice), tB = toTick(maxPrice);
  const minTick = Math.min(tA, tB), maxTick = Math.max(tA, tB);
  const budget0 = st.base.isToken0 ? baseAmount : quoteAmount;
  const budget1 = st.base.isToken0 ? quoteAmount : baseAmount;
  const plan = planLadder({ tick: st.tick, tickSpacing: st.tickSpacing, minTick, maxTick, bins, shape, budget0, budget1, slippageBps });

  // The contract refuses to mint if the price has left this band by inclusion
  // time: half a percent either side is generous on a 100 ms chain.
  const band = Math.max(st.tickSpacing, 50);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const rungs = plan.rungs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, amount0: r.amount0, amount1: r.amount1, amount0Min: r.amount0Min, amount1Min: r.amount1Min }));
  const data = rungs.length
    ? encodeFunctionData({ abi: LADDER_ABI, functionName: "mintLadder", args: [getAddress(st.pool), rungs, st.tick - band, st.tick + band, BigInt(deadline)] })
    : null;
  const wethIsToken0 = st.token0 === WETH;
  const wethNeeded = st.token0 === WETH ? plan.total0 : st.token1 === WETH ? plan.total1 : 0n;
  const other = st.token0 === WETH ? st.token1 : st.token0;
  const otherNeeded = st.token0 === WETH ? plan.total1 : plan.total0;
  const toPrice = (t) => { const raw = tickToPrice(t); return st.base.isToken0 ? raw * sc : 1 / (raw * sc); };
  return {
    pool: st.pool, tick: st.tick, price: st.price, priceUsd: st.priceUsd,
    base: st.base, quote: st.quote,
    minTick: plan.minTick, maxTick: plan.maxTick,
    minPrice: Math.min(toPrice(plan.minTick), toPrice(plan.maxTick)), maxPrice: Math.max(toPrice(plan.minTick), toPrice(plan.maxTick)),
    shape, bins: plan.rungs.length, limitedBy: plan.limitedBy, singleSided: plan.singleSided,
    total0: plan.total0.toString(), total1: plan.total1.toString(),
    baseTotal: (st.base.isToken0 ? plan.total0 : plan.total1).toString(),
    quoteTotal: (st.base.isToken0 ? plan.total1 : plan.total0).toString(),
    rungs: plan.rungs.map((r) => ({ tickLower: r.tickLower, tickUpper: r.tickUpper, priceLower: Math.min(toPrice(r.tickLower), toPrice(r.tickUpper)), priceUpper: Math.max(toPrice(r.tickLower), toPrice(r.tickUpper)), amount0: r.amount0.toString(), amount1: r.amount1.toString(), weight: r.weight })),
    tx: data ? {
      to: getAddress(LADDER_MANAGER), data,
      // Pay the WETH side as native ETH; the other token needs an allowance.
      value: wethNeeded.toString(),
      approve: otherNeeded > 0n ? { token: getAddress(other), amount: otherNeeded.toString(), spender: getAddress(LADDER_MANAGER) } : null,
      wethIsToken0, deadline,
    } : null,
  };
}

// ------------------------------------------------------------ positions

/** Every ladder a wallet holds, valued live, with fees claimable right now. */
export async function positionsOf(store, owner) {
  owner = getAddress(owner);
  const ids = await call(LADDER_MANAGER, LADDER_ABI, "laddersOf", [owner]);
  if (!ids.length) return { owner, ladders: [], totals: { valueUsd: 0, unclaimedUsd: 0, claimedUsd: 0, depositedUsd: 0 } };
  const ladders = await batchCall(ids.map((id) => ({ to: LADDER_MANAGER, abi: LADDER_ABI, fn: "ladder", args: [id] })));
  const usd = await ethUsd().catch(() => null);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const l = ladders[i];
    if (!l) continue;
    const st = await poolState(l.pool).catch(() => null);
    if (!st) continue;
    const posRaw = await batchCall(l.tokenIds.map((tid) => ({ to: NPM, abi: NPM_ABI, fn: "positions", args: [tid] })));
    const sqrtP = tickToSqrtPriceX96(st.tick);
    let held0 = 0n, held1 = 0n;
    const rungs = [];
    posRaw.forEach((p, k) => {
      if (!p) return;
      const [, , , , , tl, tu, liq] = p;
      const a = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(Number(tl)), tickToSqrtPriceX96(Number(tu)), BigInt(liq));
      held0 += a.amount0; held1 += a.amount1;
      rungs.push({ tokenId: l.tokenIds[k].toString(), tickLower: Number(tl), tickUpper: Number(tu), liquidity: liq.toString(), amount0: a.amount0.toString(), amount1: a.amount1.toString(), inRange: st.tick >= Number(tl) && st.tick < Number(tu) });
    });
    // What collect() would pay the owner right now, net of the 1%.
    let fee0 = 0n, fee1 = 0n;
    if (!l.closed) {
      try { const [f0, f1] = await call(LADDER_MANAGER, LADDER_ABI, "collect", [ids[i]], owner); fee0 = BigInt(f0); fee1 = BigInt(f1); } catch { /* nothing accrued or simulation refused */ }
    }
    const d0 = 10 ** (st.base.isToken0 ? st.base.decimals : st.quote.decimals);
    const d1 = 10 ** (st.base.isToken0 ? st.quote.decimals : st.base.decimals);
    const p0 = st.base.isToken0 ? st.priceUsd : st.quote.usdPerToken;
    const p1 = st.base.isToken0 ? st.quote.usdPerToken : st.priceUsd;
    const val = (a0, a1) => (Number(a0) / d0) * (p0 ?? 0) + (Number(a1) / d1) * (p1 ?? 0);
    // Cost basis: what went in, at the price when it went in (from our candles).
    const mintedAt = Number(l.mintedAt);
    let entryPriceUsd = st.priceUsd;
    try {
      const c = await tradeCandles({ base: st.base.address === WETH ? "eth" : st.base.address, quote: st.quote.address === WETH ? "eth" : st.quote.address, bucketSec: 60, hours: Math.max(1, Math.ceil((Date.now() / 1000 - mintedAt) / 3600) + 1), store });
      const at = c.candles.find((x) => x.time >= mintedAt) ?? c.candles.at(-1);
      if (at && st.quote.usdPerToken) entryPriceUsd = at.close * st.quote.usdPerToken;
    } catch { /* fall back to the current price */ }
    const pBase0 = st.base.isToken0 ? entryPriceUsd : st.quote.usdPerToken;
    const pBase1 = st.base.isToken0 ? st.quote.usdPerToken : entryPriceUsd;
    const depositedUsd = (Number(l.deposited0) / d0) * (pBase0 ?? 0) + (Number(l.deposited1) / d1) * (pBase1 ?? 0);
    const valueUsd = l.closed ? 0 : val(held0, held1);
    const unclaimedUsd = val(fee0, fee1);
    const claimedUsd = val(l.collected0, l.collected1);
    out.push({
      id: ids[i].toString(), pool: l.pool, closed: l.closed, mintedAt,
      base: st.base, quote: st.quote, price: st.price, priceUsd: st.priceUsd, tick: st.tick,
      deposited0: l.deposited0.toString(), deposited1: l.deposited1.toString(), depositedUsd,
      held0: held0.toString(), held1: held1.toString(), valueUsd,
      unclaimed0: fee0.toString(), unclaimed1: fee1.toString(), unclaimedUsd,
      collected0: l.collected0.toString(), collected1: l.collected1.toString(), claimedUsd,
      pnlUsd: valueUsd + unclaimedUsd + claimedUsd - depositedUsd,
      rungs,
      minTick: rungs.length ? Math.min(...rungs.map((r) => r.tickLower)) : null,
      maxTick: rungs.length ? Math.max(...rungs.map((r) => r.tickUpper)) : null,
    });
  }
  const totals = out.reduce((t, l) => ({ valueUsd: t.valueUsd + l.valueUsd, unclaimedUsd: t.unclaimedUsd + l.unclaimedUsd, claimedUsd: t.claimedUsd + l.claimedUsd, depositedUsd: t.depositedUsd + (l.closed ? 0 : l.depositedUsd) }), { valueUsd: 0, unclaimedUsd: 0, claimedUsd: 0, depositedUsd: 0 });
  return { owner, manager: LADDER_MANAGER, ethUsd: usd, ladders: out.sort((a, b) => b.mintedAt - a.mintedAt), totals };
}

export const collectCalldata = (id) => ({ to: getAddress(LADDER_MANAGER), data: encodeFunctionData({ abi: LADDER_ABI, functionName: "collect", args: [BigInt(id)] }) });
export const closeCalldata = (id) => ({ to: getAddress(LADDER_MANAGER), data: encodeFunctionData({ abi: LADDER_ABI, functionName: "close", args: [BigInt(id)] }) });
