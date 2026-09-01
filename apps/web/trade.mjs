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
import { encodeFunctionData, decodeFunctionResult, encodePacked, toEventSelector } from "viem";
import { rpcFetch } from "@ordofi/core";
import { getTokenInfo, toWhole } from "@ordofi/core/pricing";

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
export const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2"; // SwapRouter02
const FEES = [100, 500, 3000, 10000];
// SwapRouter02 sentinels. MSG_SENDER means "whoever sent the transaction",
// which makes the calldata safe to build without knowing the wallet;
// ADDRESS_THIS parks output in the router so a trailing unwrapWETH9 can pay
// the trader in native ETH.
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
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

const ROUTER_ABI = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      { type: "uint256", name: "deadline" },
      { type: "bytes[]", name: "data" },
    ],
    outputs: [{ type: "bytes[]" }],
  },
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "bytes", name: "path" },
          { type: "address", name: "recipient" },
          { type: "uint256", name: "amountIn" },
          { type: "uint256", name: "amountOutMinimum" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [] },
];

async function call(to, abi, functionName, args = []) {
  const data = await rpcFetch("eth_call", [
    { to, data: encodeFunctionData({ abi, functionName, args }) },
    "latest",
  ]);
  return decodeFunctionResult({ abi, functionName, data });
}

// ---------------------------------------------------------------------------
// Token list: the assets that demonstrably trade, straight from the index
// ---------------------------------------------------------------------------

let tokenCache = null; // { at, list }

export async function tradeTokens(store) {
  if (tokenCache && Date.now() - tokenCache.at < 600_000) return tokenCache.list;

  const seen = new Map();
  const add = async (address) => {
    const a = address.toLowerCase();
    if (seen.has(a)) return;
    try {
      const info = await getTokenInfo(a);
      if (!info.symbol || info.symbol === "?") return;
      seen.set(a, {
        address: a,
        symbol: info.symbol,
        decimals: info.decimals,
        usdPerToken: info.usdPerToken,
      });
    } catch {
      /* not an ERC-20 we can describe */
    }
  };

  await add(WETH);
  await add(USDG);

  // Every pool the watcher has seen contested is a pool with real two-sided
  // flow. Ask each (V3-style pools only; the V4 singleton has no token0()).
  const pools = store?.topPools?.(60) ?? [];
  for (const { pool } of pools) {
    try {
      const [t0, t1] = await Promise.all([
        call(pool, POOL_ABI, "token0"),
        call(pool, POOL_ABI, "token1"),
      ]);
      await add(t0);
      await add(t1);
    } catch {
      /* singleton or exotic pool — skip */
    }
  }

  const list = [...seen.values()].sort((a, b) => {
    const rank = (t) => (t.address === WETH ? 0 : t.address === USDG ? 1 : t.usdPerToken ? 2 : 3);
    return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol);
  });
  tokenCache = { at: Date.now(), list };
  return list;
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

async function quotePath(tokens, fees, amountIn) {
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

  const swapCall = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInput",
    args: [
      {
        path: best.path,
        // Native-ETH output goes to the router first, then a trailing unwrap
        // forwards it to the trader as ETH.
        recipient: nativeOut ? ADDRESS_THIS : MSG_SENDER,
        amountIn: amt,
        amountOutMinimum: minOut,
      },
    ],
  });
  const calls = [swapCall];
  if (nativeOut) {
    calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [minOut, MSG_SENDER] }));
  }
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [deadline, calls] });

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
    tx: {
      to: ROUTER,
      data,
      value: nativeIn ? "0x" + amt.toString(16) : "0x0",
    },
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
async function bestPool(base, quote) {
  const key = `${base}:${quote}`;
  const hit = poolAddrCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit;

  const pools = [];
  for (const fee of FEES) {
    try {
      const p = (await call(V3_FACTORY, FACTORY_ABI, "getPool", [base, quote, fee])).toLowerCase();
      if (p !== "0x0000000000000000000000000000000000000000") pools.push({ pool: p, fee });
    } catch {
      /* no pool at this tier */
    }
  }
  if (pools.length === 0) return null;
  const withLiq = await Promise.all(
    pools.map(async (p) => {
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
  const out = { at: Date.now(), pool: chosen.pool, fee: chosen.fee, base0: token0 === base.toLowerCase() };
  poolAddrCache.set(key, out);
  return out;
}

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
export async function tradeCandles({ base, quote, bucketSec = 60, spanBlocks = 72_000, store = null }) {
  const b = (base === NATIVE ? WETH : base).toLowerCase();
  const q = (quote === NATIVE ? WETH : quote).toLowerCase();
  const found = await bestPool(b, q);
  if (!found) throw new Error("no direct V3 pool for this pair");

  const [infoBase, infoQuote] = await Promise.all([getTokenInfo(b), getTokenInfo(q)]);
  const fromBucket = Math.floor((Date.now() / 1000 - spanBlocks * 0.1) / bucketSec) * bucketSec;
  const recorded = store?.candlesFor?.(found.pool, fromBucket) ?? [];
  const scale = 10 ** (infoBase.decimals - infoQuote.decimals);
  const orient = (p) => (found.base0 ? p : p === 0 ? 0 : 1 / p) * scale;
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

  // A freshly restarted watcher has minutes of tape; the chart wants hours.
  const DEEP_ENOUGH = 60;
  let candles = recCandles;
  let truncated = false;
  let source = "recorder";
  if (recCandles.length < DEEP_ENOUGH) {
    try {
      const walked = await candlesFromLogs(found, infoBase, infoQuote, bucketSec, spanBlocks);
      const cutoff = recCandles.length ? recCandles[0].time : Infinity;
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
    fee: found.fee,
    base: { address: b, symbol: infoBase.symbol },
    quote: { address: q, symbol: infoQuote.symbol },
    bucketSec,
    spanBlocks,
    source,
    truncated,
    swaps: candles.reduce((n, c) => n + (c.swaps ?? 0), 0),
    volumeQuote: candles.reduce((n, c) => n + (c.vol ?? 0), 0),
    last: candles.length ? candles[candles.length - 1].close : null,
    candles,
  };
}

/** The eth_getLogs walk, cached briefly per pool so chart polls don't hammer upstreams. */
async function candlesFromLogs(found, infoB, infoQ, bucketSec, spanBlocks) {
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
  let span = 4_000;
  let budget = 30;
  let truncated = false;
  while (hi >= floor && budget > 0) {
    const lo = Math.max(floor, hi - span + 1);
    budget--;
    try {
      const part = await rpcFetch("eth_getLogs", [
        {
          address: found.pool,
          topics: [V3_SWAP_TOPIC],
          fromBlock: "0x" + lo.toString(16),
          toBlock: "0x" + hi.toString(16),
        },
      ]);
      logs.push(...part);
      hi = lo - 1;
      if (part.length < 3000 && span < 40_000) span *= 2;
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
