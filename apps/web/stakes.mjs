import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
import { rpcFetch, V4 } from "@ordofi/core";
import { ethUsd } from "@ordofi/core/pricing";
import { proveDelivery, proofToJson } from "@ordofi/core/guard";
import { amountsForLiquidity, tickToSqrtPriceX96 } from "@ordofi/core/liquidity";
import { WETH, quotePath, tradeTokens } from "./trade.mjs";
import { poolState, poolsForToken, permitInfo } from "./pools.mjs";
import { STAKE_FACTORY_V4_ABI, STAKE_VAULT_V4_ABI, impactBps, keyArg, simulateSwap } from "./v4.mjs";

/**
 * Stakes: pooled always-in-range liquidity for a token's ETH pool, paid in
 * WETH. The read side and the calldata builders for OrdoStakeFactory,
 * OrdoStakeVault, OrdoStakeFarm and OrdoStakeZap — and for their V4 twins,
 * which attach to a native-ETH V4 pool instead of a WETH V3 pool. Nothing
 * here signs.
 *
 * The two zaps share one calling convention, so a deposit is built the same
 * way for either; only the address, and where the swap leg is quoted, differ.
 * V3 asks the QuoterV2; V4 has no quoter on this chain, so the leg is walked
 * through the pool's own liquidity.
 */

export const STAKE_FACTORY = process.env.ORDO_STAKE_FACTORY || "0xCe7b7a31151D3c5F7a2894842f8e1F26A05b70dA";
export const STAKE_FACTORY_V4 = process.env.ORDO_STAKE_FACTORY_V4 ? getAddress(process.env.ORDO_STAKE_FACTORY_V4) : getAddress(V4.stakeFactory);

const FACTORY_ABI = [
  { type: "function", name: "zap", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "allStakes", stateMutability: "view", inputs: [], outputs: [{ type: "tuple[]", components: [
    { name: "token", type: "address" }, { name: "pool", type: "address" }, { name: "vault", type: "address" }, { name: "farm", type: "address" }, { name: "createdAt", type: "uint64" }, { name: "creator", type: "address" },
  ] }] },
  { type: "function", name: "stakeForPool", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [
    { name: "token", type: "address" }, { name: "pool", type: "address" }, { name: "vault", type: "address" }, { name: "farm", type: "address" }, { name: "createdAt", type: "uint64" }, { name: "creator", type: "address" },
  ] }] },
  { type: "function", name: "createStake", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "address" }, { type: "address" }] },
];
const VAULT_ABI = [
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRewards", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tickLower", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "tickUpper", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [], outputs: [] },
];
const FARM_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "earned", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rewardRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "periodFinish", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "getReward", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "exit", stateMutability: "nonpayable", inputs: [], outputs: [] },
];
const ZAP_PERMIT = { name: "pm", type: "tuple", components: [{ name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] };
const ZAP_ABI = [
  { type: "function", name: "zapETH", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapWETH", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapToken", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapBoth", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapTokenWithPermit", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, ZAP_PERMIT], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapBothWithPermit", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }, ZAP_PERMIT], outputs: [{ type: "uint256" }] },
];
async function call(to, abi, functionName, args = []) {
  const data = await rpcFetch("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data });
}
const lower = (a) => String(a ?? "").toLowerCase();
const cache = new Map();
async function cached(key, ttl, fn) { const h = cache.get(key); if (h && Date.now() - h.at < ttl) return h.v; const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; }

let STORE = null;
export function setStakesStore(store) { STORE = store; }
/**
 * The zap is stateless and serves every vault, so it can move independently
 * of the factory: v2 adds the permit entry points. The factory's own zap is
 * the fallback when no address is configured.
 */
let ZAP = process.env.ORDO_STAKE_ZAP ? getAddress(process.env.ORDO_STAKE_ZAP) : "0x8a424d43dc4D44e80b93A31cB955dC86490Ba8ac";
async function zapAddress() { if (!ZAP) ZAP = getAddress(await call(STAKE_FACTORY, FACTORY_ABI, "zap")); return ZAP; }
let ZAP_V4 = process.env.ORDO_STAKE_ZAP_V4 ? getAddress(process.env.ORDO_STAKE_ZAP_V4) : getAddress(V4.stakeZap);
async function zapAddressV4() { if (!ZAP_V4) ZAP_V4 = getAddress(await call(STAKE_FACTORY_V4, STAKE_FACTORY_V4_ABI, "zap")); return ZAP_V4; }
const zapFor = (venue) => (venue === "v4" ? zapAddressV4() : zapAddress());

/** Live state of one stake: TVL, rate, stream, plus the caller's share if `owner` is given. */
export async function stakeState(entry, owner) {
  const venue = entry.venue ?? "v3";
  const [st, liq, supply, farmSupply, rate, finish, totalRewards, totalTreasury, tokenId, tl, tu, ref] = await Promise.all([
    poolState(entry.pool, entry.token),
    call(entry.vault, VAULT_ABI, "liquidity"),
    call(entry.vault, VAULT_ABI, "totalSupply"),
    call(entry.farm, FARM_ABI, "totalSupply"),
    call(entry.farm, FARM_ABI, "rewardRate"),
    call(entry.farm, FARM_ABI, "periodFinish"),
    call(entry.vault, VAULT_ABI, "totalRewards"),
    call(entry.vault, VAULT_ABI, "totalTreasury"),
    call(entry.vault, VAULT_ABI, "tokenId"),
    call(entry.vault, VAULT_ABI, "tickLower"),
    call(entry.vault, VAULT_ABI, "tickUpper"),
    // The V4 vault's own price reference: the tick its token-fee sales are bounded against, and whether it has aged enough to count.
    venue === "v4" ? call(entry.vault, STAKE_VAULT_V4_ABI, "referencePrice").catch(() => null) : null,
  ]);
  const amts = amountsForLiquidity(tickToSqrtPriceX96(st.tick), tickToSqrtPriceX96(Number(tl)), tickToSqrtPriceX96(Number(tu)), BigInt(liq));
  const wethIs0 = st.token0 === WETH;
  const wethHeld = wethIs0 ? amts.amount0 : amts.amount1;
  const tokenHeld = wethIs0 ? amts.amount1 : amts.amount0;
  // TVL in WETH: the WETH side plus the token side at the pool price (price is quote-per-base = ETH per token).
  const tvlWeth = Number(wethHeld) / 1e18 + (Number(tokenHeld) / 10 ** st.base.decimals) * st.price;
  const ratePerSec = Number(rate) / 1e18;
  const now = Math.floor(Date.now() / 1000);
  const streaming = Number(finish) > now;
  const weekly = streaming ? ratePerSec * 7 * 86_400 : 0;
  const out = {
    token: entry.token, pool: entry.pool, kind: st.kind, venue, vault: entry.vault, farm: entry.farm, createdAt: Number(entry.createdAt), creator: entry.creator,
    symbol: st.base.symbol, name: st.base.name, icon: st.base.icon, decimals: st.base.decimals, fee: st.fee, tickSpacing: st.tickSpacing,
    price: st.price, priceUsd: st.priceUsd, ethUsd: st.quote.usdPerToken,
    reference: ref && Number(ref[1]) > 0 ? { tick: Number(ref[0]), at: Number(ref[1]), usable: ref[2], price: refPrice(st, Number(ref[0])) } : null,
    tvlWeth, tvlUsd: st.quote.usdPerToken ? tvlWeth * st.quote.usdPerToken : null,
    wethHeld: wethHeld.toString(), tokenHeld: tokenHeld.toString(),
    shares: supply.toString(), staked: farmSupply.toString(), liquidity: liq.toString(), tokenId: tokenId.toString(),
    rewardRate: rate.toString(), periodFinish: Number(finish), streaming, weeklyWeth: weekly,
    // "7d rate": what the current stream pays a week, annualised against TVL.
    rate7d: tvlWeth > 0 ? weekly / tvlWeth : 0, apr: tvlWeth > 0 ? (weekly * 52) / tvlWeth : 0,
    totalRewardsWeth: Number(totalRewards) / 1e18, totalTreasuryWeth: Number(totalTreasury) / 1e18,
  };
  if (owner) {
    const [staked, earned, loose] = await Promise.all([call(entry.farm, FARM_ABI, "balanceOf", [owner]), call(entry.farm, FARM_ABI, "earned", [owner]), call(entry.vault, VAULT_ABI, "balanceOf", [owner])]);
    const frac = supply > 0n ? Number(staked + loose) / Number(supply) : 0;
    out.me = {
      staked: staked.toString(), loose: loose.toString(), earnedWeth: Number(earned) / 1e18,
      valueWeth: frac * tvlWeth, valueUsd: st.quote.usdPerToken ? frac * tvlWeth * st.quote.usdPerToken : null,
      wethHeld: (BigInt(Math.floor(frac * 1e9)) * wethHeld / 1_000_000_000n).toString(),
      tokenHeld: (BigInt(Math.floor(frac * 1e9)) * tokenHeld / 1_000_000_000n).toString(),
    };
  }
  return out;
}

/** A pool's price in quote-per-base whole units at a tick, oriented like the pool state. */
function refPrice(st, tick) {
  const raw = Math.pow(1.0001, tick), sc = 10 ** (st.base.decimals - st.quote.decimals);
  return st.base.isToken0 ? raw * sc : 1 / (raw * sc);
}

/** Every stake either factory has created, each tagged with its venue; the V4 ones name their pool by PoolId. */
async function allEntries() {
  return cached("stakes:entries", 30_000, async () => {
    const [v3, v4] = await Promise.all([
      call(STAKE_FACTORY, FACTORY_ABI, "allStakes"),
      call(STAKE_FACTORY_V4, STAKE_FACTORY_V4_ABI, "allStakes").catch((e) => { console.warn(`stakes | V4 factory unavailable: ${e?.message ?? e}`); return []; }),
    ]);
    return [
      ...v3.map((e) => ({ venue: "v3", token: lower(e.token), pool: lower(e.pool), vault: e.vault, farm: e.farm, createdAt: e.createdAt, creator: e.creator })),
      ...v4.map((e) => ({ venue: "v4", token: lower(e.token), pool: lower(e.poolId), vault: e.vault, farm: e.farm, createdAt: e.createdAt, creator: e.creator })),
    ];
  });
}

/** Every stake, deepest first. */
export async function stakesList(owner) {
  const entries = await allEntries();
  const rows = (await Promise.all(entries.map((e) => stakeState(e, owner).catch(() => null)))).filter(Boolean);
  rows.sort((a, b) => b.tvlWeth - a.tvlWeth);
  const totals = { tvlWeth: rows.reduce((n, r) => n + r.tvlWeth, 0), stakes: rows.length, rewardsWeth: rows.reduce((n, r) => n + r.totalRewardsWeth, 0) };
  const [zap, zapV4] = await Promise.all([zapAddress().catch(() => null), zapAddressV4().catch(() => null)]);
  return { factory: STAKE_FACTORY, factories: { v3: STAKE_FACTORY, v4: STAKE_FACTORY_V4 }, zap, zaps: { v3: zap, v4: zapV4 }, stakes: rows, totals, ethUsd: await ethUsd().catch(() => null) };
}

/** One stake by vault address, with the owner's view. */
export async function stakeView(vault, owner) {
  const find = async () => (await allEntries()).find((x) => lower(x.vault) === lower(vault));
  let e = await find();
  if (!e) { cache.delete("stakes:entries"); e = await find(); } // just created: the cached list predates it
  if (!e) throw new Error("no such stake");
  return stakeState(e, owner);
}

/**
 * Plan a deposit. mode "one": a single coin, half swapped through the pool;
 * "both": ETH and token together, no swap. Returns the zap calldata, the
 * quote for the swapped half, price impact and what protects the user.
 */
export async function stakeQuote({ vault, mode = "one", asset = "eth", amount = 0n, tokenAmount = 0n, slippageBps = 100, from = null, permit = null }) {
  const s = await stakeView(vault);
  const zap = await zapFor(s.venue);
  const token = s.token;
  const tokenIsIn = asset === "token";
  let quote = null, minOut = 0n, data, value = 0n, approve = null;
  if (mode === "both") {
    if (amount === 0n && tokenAmount === 0n) throw new Error("nothing to deposit");
    value = amount;
    if (tokenAmount > 0n) approve = { token: getAddress(token), spender: zap, amount: tokenAmount.toString() };
    const signed = approve && permit ? [{ value: permit.value, deadline: permit.deadline, v: permit.v, r: permit.r, s: permit.s }] : null;
    data = signed
      ? encodeFunctionData({ abi: ZAP_ABI, functionName: "zapBothWithPermit", args: [getAddress(vault), tokenAmount, signed[0]] })
      : encodeFunctionData({ abi: ZAP_ABI, functionName: "zapBoth", args: [getAddress(vault), tokenAmount] });
    if (signed) approve = null;
  } else {
    if (amount === 0n) throw new Error("nothing to deposit");
    const half = amount / 2n;
    const q = await swapLegQuote(s, tokenIsIn, half);
    if (!q) throw new Error("no quote for the swap leg");
    minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    quote = { swapIn: half.toString(), swapOut: q.amountOut.toString(), minOut: minOut.toString(), priceImpactBps: q.impactBps, via: q.via };
    if (tokenIsIn) {
      approve = { token: getAddress(token), spender: zap, amount: amount.toString() };
      if (permit) {
        data = encodeFunctionData({ abi: ZAP_ABI, functionName: "zapTokenWithPermit", args: [getAddress(vault), amount, minOut, { value: permit.value, deadline: permit.deadline, v: permit.v, r: permit.r, s: permit.s }] });
        approve = null;
      } else data = encodeFunctionData({ abi: ZAP_ABI, functionName: "zapToken", args: [getAddress(vault), amount, minOut] });
    } else if (asset === "weth") {
      data = encodeFunctionData({ abi: ZAP_ABI, functionName: "zapWETH", args: [getAddress(vault), amount, minOut] });
      approve = { token: getAddress(WETH), spender: zap, amount: amount.toString() };
    } else {
      data = encodeFunctionData({ abi: ZAP_ABI, functionName: "zapETH", args: [getAddress(vault), minOut] });
      value = amount;
    }
  }
  // The zap swaps, deposits and stakes for msg.sender, then refunds dust to
  // msg.sender. Prove exactly that from the depositor's address: their farm
  // balance rises, they pay no more than they typed, the zap keeps nothing.
  const check = await proven({
    from,
    tx: { to: zap, data, value },
    approval: approve ? { token: approve.token, spender: zap, amount: BigInt(approve.amount) } : null,
    expect: [{ asset: getAddress(s.farm), min: 1n }],
    // The token side is capped whether it arrives by approve or by permit.
    pay: [...(value > 0n ? [{ asset: "eth", max: value }] : []), ...(approve ? [{ asset: approve.token, max: BigInt(approve.amount) }] : (mode === "both" ? tokenAmount : tokenIsIn ? amount : 0n) > 0n ? [{ asset: getAddress(token), max: mode === "both" ? tokenAmount : amount }] : [])],
    mustNotRetain: [{ holder: zap, asset: "eth" }, { holder: zap, asset: getAddress(WETH) }, { holder: zap, asset: getAddress(token) }],
  });
  // Whether the token side could be granted by signature instead of an approve transaction.
  const tokenSide = mode === "both" ? tokenAmount : tokenIsIn ? amount : 0n;
  const pinfo = tokenSide > 0n ? await permitInfo(token, from).catch(() => ({ supported: false })) : null;
  return {
    vault: s.vault, farm: s.farm, venue: s.venue, symbol: s.symbol, decimals: s.decimals, mode, asset, quote, slippageBps,
    ...check,
    tx: check.guard.ok ? { to: zap, data, value: value.toString(), approve } : null,
    permit: pinfo ? { ...pinfo, spender: zap, value: tokenSide.toString(), deadline: Math.floor(Date.now() / 1000) + 900, applied: !!permit && !approve } : null,
  };
}

/**
 * The zap's swap leg: half the deposit, one coin into the other, through the
 * stake's own pool. V3 asks the QuoterV2 and measures impact against a sliver;
 * V4 walks the pool's liquidity profile and measures against the spot price.
 */
async function swapLegQuote(s, tokenIsIn, half) {
  if (s.venue === "v4") {
    const st = await poolState(s.pool, s.token);
    const zeroForOne = !tokenIsIn; // ETH is currency zero in every V4 ETH pool
    const sim = await simulateSwap({ poolId: s.pool, spacing: st.tickSpacing, fee: st.fee, tick: st.tick, sqrtPriceX96: st.sqrtPriceX96, liquidity: st.liquidity, zeroForOne, amountIn: half });
    if (sim.amountOut <= 0n || sim.partial) return null;
    return { amountOut: sim.amountOut, impactBps: impactBps({ amountIn: half, amountOut: sim.amountOut, sqrtPriceX96: st.sqrtPriceX96, fee: st.fee, zeroForOne }), via: "v4-profile" };
  }
  const [tin, tout] = tokenIsIn ? [s.token, WETH] : [WETH, s.token];
  const q = await quotePath([tin, tout], [s.fee], half);
  if (!q) return null;
  const sliver = half / 1000n;
  const ref = sliver > 0n ? await quotePath([tin, tout], [s.fee], sliver) : null;
  const impact = ref && ref.amountOut > 0n ? Math.max(0, Math.round((1 - (Number(q.amountOut) / Number(half)) / (Number(ref.amountOut) / Number(sliver))) * 10_000)) : null;
  return { amountOut: q.amountOut, impactBps: impact, via: "quoter" };
}

/**
 * Only a transaction that has been executed from the signer's own address, and
 * seen to pay them, is handed out. Without a wallet there is nothing to prove
 * against, so there is no `tx`.
 */
async function proven({ from, tx, approval = null, expect = [], pay = [], mustNotRetain = [] }) {
  if (!from || !/^0x[0-9a-fA-F]{40}$/.test(from)) {
    return { for: null, guard: { ok: false, reason: "connect a wallet: the transaction is built and verified for your address" } };
  }
  const proof = await proveDelivery({ from, tx, approval, expect, pay, mustNotRetain });
  if (!proof.ok) console.error(`stakes | REFUSED ${from} -> ${tx.to}: ${proof.reason}`);
  return { for: from, guard: proofToJson(proof) };
}

export const farmWithdrawCalldata = (farm, shares) => ({ to: getAddress(farm), data: encodeFunctionData({ abi: FARM_ABI, functionName: "withdraw", args: [BigInt(shares)] }) });

/**
 * Burn vault shares for their slice of the position. The minimums are the
 * slice at the current price less `slippageBps`, so a price pushed between
 * quote and inclusion makes the withdrawal revert instead of paying out a
 * skewed mix. The proof then requires `from` to actually receive both sides.
 */
export async function vaultWithdrawPlan({ vault, shares, to, from = null, slippageBps = 100 }) {
  shares = BigInt(shares);
  if (shares <= 0n) throw new Error("nothing to withdraw");
  const s = await stakeView(vault);
  const supply = BigInt(s.shares);
  if (supply === 0n) throw new Error("the vault has no shares");
  if (shares > supply) throw new Error("more shares than exist");
  const bps = BigInt(Math.max(0, Math.min(5000, Math.round(slippageBps))));
  const wethPart = (BigInt(s.wethHeld) * shares) / supply;
  const tokenPart = (BigInt(s.tokenHeld) * shares) / supply;
  const minWeth = (wethPart * (10_000n - bps)) / 10_000n;
  const minToken = (tokenPart * (10_000n - bps)) / 10_000n;
  // V3 vaults take minimums in token0/token1 order; V4 vaults always as (eth, token), ETH being currency zero.
  const wethIs0 = s.venue === "v4" || WETH.toLowerCase() < s.token.toLowerCase();
  const data = encodeFunctionData({
    abi: s.venue === "v4" ? STAKE_VAULT_V4_ABI : VAULT_ABI,
    functionName: "withdraw",
    args: [shares, wethIs0 ? minWeth : minToken, wethIs0 ? minToken : minWeth, getAddress(to)],
  });
  const tx = { to: getAddress(vault), data };
  const check = await proven({
    from,
    tx,
    // The WETH side is paid out as ETH.
    expect: [{ asset: "eth", min: minWeth }, { asset: getAddress(s.token), min: minToken }],
    pay: [{ asset: getAddress(vault), max: shares }],
  });
  return {
    vault: s.vault, venue: s.venue, symbol: s.symbol, decimals: s.decimals, shares: shares.toString(), slippageBps: Number(bps),
    expected: { weth: wethPart.toString(), token: tokenPart.toString() },
    minimum: { weth: minWeth.toString(), token: minToken.toString() },
    ...check,
    tx: check.guard.ok ? tx : null,
  };
}
export const claimCalldata = (farm) => ({ to: getAddress(farm), data: encodeFunctionData({ abi: FARM_ABI, functionName: "getReward" }) });
export const harvestCalldata = (vault) => ({ to: getAddress(vault), data: encodeFunctionData({ abi: VAULT_ABI, functionName: "harvest" }) });

/**
 * Where a new stake for `token` would attach: its deepest ETH pool in the
 * chosen venue, and whether one already exists there. Both venues are
 * reported so the page can offer whichever the token actually trades in.
 */
export async function stakeCreatePlan(token, venue = null) {
  token = lower(token);
  const all = (await poolsForToken(token)).filter((p) => p.quote === WETH);
  const options = { v3: all.filter((p) => p.kind === "v3")[0] ?? null, v4: all.filter((p) => p.kind === "v4")[0] ?? null };
  // No venue asked for: the one holding the deeper ETH pool — a token often has
  // an empty pool in one version and all its liquidity in the other. V3 on a tie.
  if (!venue) {
    const depth = (p) => (p ? BigInt(p.liquidity) : -1n);
    venue = depth(options.v4) > depth(options.v3) ? "v4" : "v3";
  }
  const pool = options[venue];
  if (!pool) {
    if (options.v3 || options.v4) throw new Error(`this token has no Uniswap ${venue.toUpperCase()} pool against ETH yet — it does have a ${venue === "v3" ? "V4" : "V3"} one`);
    throw new Error("this token has no Uniswap V3 or V4 pool against ETH yet");
  }
  const info = (await tradeTokens(STORE)).find((t) => t.address === token);
  let existing, tx;
  if (venue === "v4") {
    const st = await poolState(pool.pool, token);
    existing = await call(STAKE_FACTORY_V4, STAKE_FACTORY_V4_ABI, "stakeForPool", [pool.pool]);
    tx = { to: getAddress(STAKE_FACTORY_V4), data: encodeFunctionData({ abi: STAKE_FACTORY_V4_ABI, functionName: "createStake", args: [keyArg(st.key)] }) };
  } else {
    existing = await call(STAKE_FACTORY, FACTORY_ABI, "stakeForPool", [getAddress(pool.pool)]);
    tx = { to: getAddress(STAKE_FACTORY), data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createStake", args: [getAddress(pool.pool)] }) };
  }
  return {
    token, venue, symbol: info?.symbol ?? null, name: info?.name ?? null, pool: pool.pool, kind: pool.kind, fee: pool.fee, tickSpacing: pool.tickSpacing, liquidity: pool.liquidity,
    venues: Object.fromEntries(Object.entries(options).map(([k, p]) => [k, p ? { pool: p.pool, fee: p.fee, liquidity: p.liquidity } : null])),
    exists: lower(existing.vault) !== "0x0000000000000000000000000000000000000000" ? { vault: existing.vault, farm: existing.farm } : null,
    tx,
  };
}
