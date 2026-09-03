import { encodeFunctionData, getAddress, parseAbiItem, toEventSelector } from "viem";
import { V4, isV4PoolId } from "@ordofi/core";
import { Q96, alignTick, amountsForLiquidity, tickToSqrtPriceX96 } from "@ordofi/core/liquidity";
import { batchCall, call } from "./rpc.mjs";
import { WETH } from "./trade.mjs";

/**
 * Uniswap V4 for the liquidity pages: the ABIs of Ordo's V4 contracts and of
 * the singleton's read lens, the pool key behind a PoolId, the liquidity
 * profile read through StateView, and an exact-in swap simulated on that
 * profile — Robinhood Chain has no V4 quoter, so the stake zap's quote is
 * computed here with the PoolManager's own arithmetic.
 *
 * Native ETH is currency zero in every V4 pool that holds it (address zero
 * sorts first). Readers here report it as WETH so prices, names and balances
 * flow through the same code as V3; only calldata speaks address zero.
 */

export const NATIVE0 = V4.nativeCurrency;
const lower = (a) => String(a ?? "").toLowerCase();

// ------------------------------------------------------------------ ABIs

export const POOL_KEY = { name: "key", type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] };
const PERMIT_TUPLE = { name: "permit", type: "tuple", components: [
  { name: "token", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" },
  { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
] };
const RUNG_TUPLE = { name: "rungs", type: "tuple[]", components: [
  { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
  { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" },
  { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
] };

/** The singleton's one entry point a pool needs to exist: initialize(key, sqrtPriceX96). Anyone may call it. */
export const POOL_MANAGER_ABI = [
  { type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [POOL_KEY, { name: "sqrtPriceX96", type: "uint160" }], outputs: [{ type: "int24" }] },
];
/** The tick spacing Uniswap pairs with each standard fee tier; V4 lets any pair be chosen, these are the ones people expect. */
export const SPACING_FOR_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/**
 * Calldata to create a plain (hookless, fixed-fee) V4 pool of native ETH and a
 * token, opening at `rawPrice` — token1 per token0 in raw units — so the first
 * position can be placed around the price the token already trades at.
 */
export function initializeCalldata(token, fee, rawPrice) {
  const tickSpacing = SPACING_FOR_FEE[fee];
  if (!tickSpacing) throw new Error("fee tier must be 0.01%, 0.05%, 0.3% or 1%");
  if (!(rawPrice > 0) || !Number.isFinite(rawPrice)) throw new Error("a starting price is needed");
  const key = { currency0: NATIVE0, currency1: getAddress(token), fee, tickSpacing, hooks: NATIVE0 };
  // sqrt(price) · 2^96, built in two halves so the double's 53 bits are spent on the mantissa, not the exponent.
  const sqrt = Math.sqrt(rawPrice);
  const sqrtPriceX96 = BigInt(Math.floor(sqrt * 2 ** 48)) * (1n << 48n);
  return { key, sqrtPriceX96, data: encodeFunctionData({ abi: POOL_MANAGER_ABI, functionName: "initialize", args: [key, sqrtPriceX96] }) };
}

/** OrdoLadderManagerV4: the V3 manager's surface with a PoolKey where the pool address was. */
export const LADDER_V4_ABI = [
  { type: "function", name: "openLadder", stateMutability: "payable", inputs: [POOL_KEY, RUNG_TUPLE, { name: "shape", type: "uint8" }, { name: "minTick", type: "int24" }, { name: "maxTick", type: "int24" }, { name: "deadline", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "openLadderWithPermit", stateMutability: "payable", inputs: [POOL_KEY, RUNG_TUPLE, { name: "shape", type: "uint8" }, { name: "minTick", type: "int24" }, { name: "maxTick", type: "int24" }, { name: "deadline", type: "uint256" }, PERMIT_TUPLE], outputs: [{ type: "uint256" }] },
  { type: "function", name: "addLiquidity", stateMutability: "payable", inputs: [{ name: "ladderId", type: "uint256" }, RUNG_TUPLE, { name: "deadline", type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "addLiquidityWithPermit", stateMutability: "payable", inputs: [{ name: "ladderId", type: "uint256" }, RUNG_TUPLE, { name: "deadline", type: "uint256" }, PERMIT_TUPLE], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "closeBins", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256[]" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "close", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "closeMany", stateMutability: "nonpayable", inputs: [{ type: "uint256[]" }], outputs: [] },
  { type: "function", name: "laddersOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "ladderCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "toId", stateMutability: "pure", inputs: [POOL_KEY], outputs: [{ type: "bytes32" }] },
  {
    type: "function", name: "preview", stateMutability: "view", inputs: [POOL_KEY, RUNG_TUPLE],
    outputs: [{ type: "int24" }, { type: "uint128[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
  },
  {
    type: "function", name: "ladder", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "poolId", type: "bytes32" }, POOL_KEY, { name: "shape", type: "uint8" },
      { name: "openedAt", type: "uint64" }, { name: "closedAt", type: "uint64" }, { name: "openBins", type: "uint32" },
      { name: "deposited0", type: "uint256" }, { name: "deposited1", type: "uint256" },
      { name: "withdrawn0", type: "uint256" }, { name: "withdrawn1", type: "uint256" },
      { name: "collected0", type: "uint256" }, { name: "collected1", type: "uint256" },
      { name: "bins", type: "tuple[]", components: [
        { name: "tokenId", type: "uint256" }, { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }, { name: "open", type: "bool" },
      ] },
    ] }],
  },
  parseAbiItem("event LadderOpened(uint256 indexed ladderId, address indexed owner, bytes32 indexed poolId, uint8 shape, uint256 bins, uint256 deposited0, uint256 deposited1)"),
  parseAbiItem("event LiquidityAdded(uint256 indexed ladderId, address indexed owner, uint256 added0, uint256 added1, uint256 newBins)"),
  parseAbiItem("event FeesCollected(uint256 indexed ladderId, address indexed owner, uint256 toOwner0, uint256 toOwner1, uint256 toTreasury0, uint256 toTreasury1)"),
  parseAbiItem("event BinsClosed(uint256 indexed ladderId, address indexed owner, uint256 count, uint256 principal0, uint256 principal1, uint256 remaining)"),
  parseAbiItem("event LadderClosed(uint256 indexed ladderId, address indexed owner)"),
];
export const LADDER_V4_TOPICS = LADDER_V4_ABI.filter((x) => x.type === "event").map((e) => toEventSelector(e));

/** The PoolManager announces every liquidity change; the PositionManager's salt is the token id. */
export const MODIFY_LIQUIDITY_EVENT = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
export const MODIFY_LIQUIDITY_TOPIC = toEventSelector(MODIFY_LIQUIDITY_EVENT);

/** StateView: the read lens over the singleton's storage. */
export const STATE_VIEW_ABI = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "getTickBitmap", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "int16" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTickLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "int24" }], outputs: [{ type: "uint128" }, { type: "int128" }] },
];

/** PositionManager: positions are ERC-721s; liquidity and range are read per token id. */
export const POSM_ABI = [
  { type: "function", name: "getPositionLiquidity", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "getPoolAndPositionInfo", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [POOL_KEY, { type: "uint256" }] },
];

const STAKE_TUPLE = { type: "tuple", components: [
  { name: "token", type: "address" }, { name: "poolId", type: "bytes32" }, { name: "vault", type: "address" }, { name: "farm", type: "address" }, { name: "createdAt", type: "uint64" }, { name: "creator", type: "address" },
] };
export const STAKE_FACTORY_V4_ABI = [
  { type: "function", name: "zap", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "allStakes", stateMutability: "view", inputs: [], outputs: [{ ...STAKE_TUPLE, type: "tuple[]" }] },
  { type: "function", name: "stakeForPool", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [STAKE_TUPLE] },
  { type: "function", name: "createStake", stateMutability: "nonpayable", inputs: [POOL_KEY], outputs: [{ type: "address" }, { type: "address" }] },
];
export const STAKE_VAULT_V4_ABI = [
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRewards", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tickLower", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "tickUpper", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "poolId", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "farm", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "key", stateMutability: "view", inputs: [], outputs: [POOL_KEY] },
  { type: "function", name: "referencePrice", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }, { type: "uint40" }, { type: "bool" }] },
  { type: "function", name: "previewDeposit", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [], outputs: [] },
];

// -------------------------------------------------------------- pool keys

/** The PoolKey a PoolId stands for, from the Initialize events the watcher recorded. Null until the walk has announced it. */
export function poolKeyOf(store, poolId) {
  const p = store?.v4Pool?.(lower(poolId));
  if (!p) return null;
  return {
    poolId: lower(p.poolId), currency0: lower(p.currency0), currency1: lower(p.currency1),
    fee: Number(p.fee), tickSpacing: Number(p.tickSpacing), hooks: lower(p.hooks),
    native0: lower(p.currency0) === NATIVE0, hooked: lower(p.hooks) !== NATIVE0, dynamicFee: Number(p.fee) === V4.dynamicFeeFlag,
    block: p.block,
  };
}

/** The key as calldata wants it. */
export const keyArg = (k) => ({
  currency0: getAddress(k.currency0), currency1: getAddress(k.currency1),
  fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: getAddress(k.hooks ?? NATIVE0),
});

/** A key read back from a contract (checksummed, bigint-free) in the store's shape. */
export const keyFromChain = (k) => ({
  currency0: lower(k.currency0), currency1: lower(k.currency1), fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: lower(k.hooks),
  native0: lower(k.currency0) === NATIVE0, hooked: lower(k.hooks) !== NATIVE0, dynamicFee: Number(k.fee) === V4.dynamicFeeFlag,
});

/** What the liquidity pages can work with: an ETH pool with no hook and a fixed fee. */
export const isPlainEthPool = (k) => !!k && k.native0 && !k.hooked && !k.dynamicFee;
/** Native ETH or USDG on one side, no hook, a fixed fee: a pool the ladder manager can work without surprises. */
export const isPlainMoneyPool = (k, usdg) => !!k && !k.hooked && !k.dynamicFee && (k.native0 || lower(k.currency0) === usdg || lower(k.currency1) === usdg);

/** The ERC-20 the pool is about, with native ETH reported as WETH. */
export const tokensOf = (k) => ({ token0: k.native0 ? WETH : k.currency0, token1: k.currency1 });

export { isV4PoolId };

// --------------------------------------------------------------- reads

export async function slot0(poolId) {
  const [s, l] = await batchCall([
    { to: V4.stateView, abi: STATE_VIEW_ABI, fn: "getSlot0", args: [poolId] },
    { to: V4.stateView, abi: STATE_VIEW_ABI, fn: "getLiquidity", args: [poolId] },
  ]);
  if (!s || s[0] === 0n) throw new Error("this V4 pool is not initialised");
  return { sqrtPriceX96: s[0], tick: Number(s[1]), protocolFee: Number(s[2]), lpFee: Number(s[3]), liquidity: l ?? 0n };
}

export const liquidityOf = (poolIds) => batchCall(poolIds.map((id) => ({ to: V4.stateView, abi: STATE_VIEW_ABI, fn: "getLiquidity", args: [id] })));

/**
 * The initialised ticks in [lo, hi] and the net liquidity at each, read off
 * the tick bitmap the way the pool itself finds its next tick. Ticks are
 * compressed by the spacing before the bitmap is indexed; a word holds 256.
 */
const profileCache = new Map();
export async function tickProfile(poolId, spacing, lo, hi) {
  const key = `${poolId}:${lo}:${hi}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const wordOf = (t) => Math.floor(Math.floor(t / spacing) / 256);
  const words = [];
  for (let w = wordOf(lo); w <= wordOf(hi); w++) words.push(w);
  const bitmaps = await batchCall(words.map((w) => ({ to: V4.stateView, abi: STATE_VIEW_ABI, fn: "getTickBitmap", args: [poolId, w] })));
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
  const nets = await batchCall(initialised.map((t) => ({ to: V4.stateView, abi: STATE_VIEW_ABI, fn: "getTickLiquidity", args: [poolId, t] })));
  const netAt = new Map(initialised.map((t, i) => [t, nets[i] ? BigInt(nets[i][1]) : 0n]));
  const v = { initialised, netAt };
  profileCache.set(key, { at: Date.now(), v });
  return v;
}

/** Active liquidity per tick range around the current tick: [from, to, L] segments over [lo, hi]. */
export function segmentsOf({ tick, liquidity, initialised, netAt }, lo, hi) {
  const L0 = BigInt(liquidity);
  const above = initialised.filter((t) => t > tick);
  const below = initialised.filter((t) => t <= tick).reverse();
  const segs = [];
  let L = L0, from = tick;
  for (const t of above) { segs.push([from, t, L]); L += netAt.get(t) ?? 0n; from = t; }
  segs.push([from, hi, L]);
  L = L0; let to = tick;
  for (const t of below) { segs.push([t, to, L]); L -= netAt.get(t) ?? 0n; to = t; }
  segs.push([lo, to, L]);
  return segs;
}

/**
 * Everything the pool holds within `spanTicks` of the price, as token
 * amounts. The singleton keeps one balance per currency for every pool, so
 * there is no reserve to read; the liquidity profile is summed instead.
 */
export async function holdings(poolId, spacing, tick, liquidity, spanTicks = 23_026) {
  const lo = alignTick(tick - spanTicks, spacing, "down"), hi = alignTick(tick + spanTicks, spacing, "up");
  const prof = await tickProfile(poolId, spacing, lo, hi);
  const sqrtP = tickToSqrtPriceX96(tick);
  let amount0 = 0n, amount1 = 0n;
  for (const [f, t, L] of segmentsOf({ tick, liquidity, ...prof }, lo, hi)) {
    if (L <= 0n || t <= f) continue;
    const a = amountsForLiquidity(sqrtP, tickToSqrtPriceX96(f), tickToSqrtPriceX96(t), L);
    amount0 += a.amount0; amount1 += a.amount1;
  }
  return { amount0, amount1, spanTicks };
}

// ---------------------------------------------------------------- swaps

/**
 * An exact-in swap walked through the pool's live liquidity, step by step
 * across initialised ticks, with the LP fee taken off the input the way the
 * PoolManager does. Returns what comes out and where the price lands; a swap
 * that runs past the profile's edge is reported as partial rather than
 * guessed at.
 */
export async function simulateSwap({ poolId, spacing, fee, tick, sqrtPriceX96, liquidity, zeroForOne, amountIn, spanTicks = 23_026 }) {
  const lo = alignTick(tick - spanTicks, spacing, "down"), hi = alignTick(tick + spanTicks, spacing, "up");
  const { initialised, netAt } = await tickProfile(poolId, spacing, lo, hi);
  const ONE = 1_000_000n, feeNum = ONE - BigInt(fee);
  let sqrt = BigInt(sqrtPriceX96), L = BigInt(liquidity), remaining = BigInt(amountIn), out = 0n;
  const path = zeroForOne ? initialised.filter((t) => t <= tick).reverse() : initialised.filter((t) => t > tick);
  let crossed = 0;
  for (const t of path) {
    if (remaining <= 0n) break;
    const target = tickToSqrtPriceX96(t);
    const net = netAt.get(t) ?? 0n;
    if (L > 0n) {
      const afterFee = (remaining * feeNum) / ONE;
      if (zeroForOne) {
        const need = (L * Q96 * (sqrt - target)) / (sqrt * target); // amount0 to reach the tick
        if (afterFee >= need) {
          out += (L * (sqrt - target)) / Q96;
          remaining -= need === 0n ? 0n : (need * ONE + feeNum - 1n) / feeNum;
          sqrt = target;
        } else {
          const next = (L * Q96 * sqrt) / (L * Q96 + afterFee * sqrt);
          out += (L * (sqrt - next)) / Q96;
          sqrt = next; remaining = 0n;
          break;
        }
      } else {
        const need = (L * (target - sqrt)) / Q96; // amount1 to reach the tick
        if (afterFee >= need) {
          out += (L * Q96 * (target - sqrt)) / (target * sqrt);
          remaining -= need === 0n ? 0n : (need * ONE + feeNum - 1n) / feeNum;
          sqrt = target;
        } else {
          const next = sqrt + (afterFee * Q96) / L;
          out += (L * Q96 * (next - sqrt)) / (next * sqrt);
          sqrt = next; remaining = 0n;
          break;
        }
      }
    } else sqrt = target;
    L = zeroForOne ? L - net : L + net;
    crossed++;
  }
  // Still input left with no initialised tick ahead: the last segment runs to the profile's edge.
  if (remaining > 0n && L > 0n) {
    const afterFee = (remaining * feeNum) / ONE;
    if (zeroForOne) {
      const next = (L * Q96 * sqrt) / (L * Q96 + afterFee * sqrt);
      out += (L * (sqrt - next)) / Q96; sqrt = next;
    } else {
      const next = sqrt + (afterFee * Q96) / L;
      out += (L * Q96 * (next - sqrt)) / (next * sqrt); sqrt = next;
    }
    remaining = 0n;
  }
  const edge = zeroForOne ? tickToSqrtPriceX96(lo) : tickToSqrtPriceX96(hi);
  const partial = remaining > 0n || (zeroForOne ? sqrt < edge : sqrt > edge);
  return { amountOut: out, consumed: BigInt(amountIn) - remaining, sqrtAfter: sqrt, crossed, partial };
}

/** Price impact of an exact-in swap in basis points: execution against the spot price net of the fee. */
export function impactBps({ amountIn, amountOut, sqrtPriceX96, fee, zeroForOne }) {
  const p = Number(BigInt(sqrtPriceX96)) / 2 ** 96; // sqrt(token1/token0)
  const spot = zeroForOne ? p * p : 1 / (p * p);
  const ideal = Number(amountIn) * spot * (1 - fee / 1e6);
  if (!(ideal > 0)) return null;
  return Math.max(0, Math.round((1 - Number(amountOut) / ideal) * 10_000));
}

// -------------------------------------------------------------- stakes

export const stakeFactoryZap = () => call(V4.stakeFactory, STAKE_FACTORY_V4_ABI, "zap");
