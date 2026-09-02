import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbiItem } from "viem";
import { rpcFetch } from "@ordofi/core";
import { ethUsd } from "@ordofi/core/pricing";
import { proveDelivery, proofToJson } from "@ordofi/core/guard";
import { amountsForLiquidity, tickToSqrtPriceX96 } from "@ordofi/core/liquidity";
import { WETH, USDG, poolCache, quotePath, tradeTokens } from "./trade.mjs";
import { poolState, poolsForToken } from "./pools.mjs";

/**
 * Stakes: pooled always-in-range liquidity for a token's ETH pool, paid in
 * WETH. The read side and the calldata builders for OrdoStakeFactory,
 * OrdoStakeVault, OrdoStakeFarm and OrdoStakeZap. Nothing here signs.
 */

export const STAKE_FACTORY = process.env.ORDO_STAKE_FACTORY ?? "0xCe7b7a31151D3c5F7a2894842f8e1F26A05b70dA";
const NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3";

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
const ZAP_ABI = [
  { type: "function", name: "zapETH", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapWETH", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapToken", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "zapBoth", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
];
const NPM_ABI = [{ type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
  { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" },
] }];

async function call(to, abi, functionName, args = []) {
  const data = await rpcFetch("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data });
}
const lower = (a) => String(a ?? "").toLowerCase();
const cache = new Map();
async function cached(key, ttl, fn) { const h = cache.get(key); if (h && Date.now() - h.at < ttl) return h.v; const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; }

let STORE = null;
export function setStakesStore(store) { STORE = store; }
let ZAP = null;
async function zapAddress() { if (!ZAP) ZAP = getAddress(await call(STAKE_FACTORY, FACTORY_ABI, "zap")); return ZAP; }

/** Live state of one stake: TVL, rate, stream, plus the caller's share if `owner` is given. */
export async function stakeState(entry, owner) {
  const [st, liq, supply, farmSupply, rate, finish, totalRewards, totalTreasury, tokenId, tl, tu] = await Promise.all([
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
    token: entry.token, pool: entry.pool, vault: entry.vault, farm: entry.farm, createdAt: Number(entry.createdAt), creator: entry.creator,
    symbol: st.base.symbol, name: st.base.name, icon: st.base.icon, decimals: st.base.decimals, fee: st.fee,
    price: st.price, priceUsd: st.priceUsd, ethUsd: st.quote.usdPerToken,
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

/** Every stake, deepest first. */
export async function stakesList(owner) {
  const entries = await cached("stakes:entries", 30_000, () => call(STAKE_FACTORY, FACTORY_ABI, "allStakes"));
  const rows = (await Promise.all(entries.map((e) => stakeState({ ...e, token: lower(e.token), pool: lower(e.pool) }, owner).catch(() => null)))).filter(Boolean);
  rows.sort((a, b) => b.tvlWeth - a.tvlWeth);
  const totals = { tvlWeth: rows.reduce((n, r) => n + r.tvlWeth, 0), stakes: rows.length, rewardsWeth: rows.reduce((n, r) => n + r.totalRewardsWeth, 0) };
  return { factory: STAKE_FACTORY, zap: await zapAddress().catch(() => null), stakes: rows, totals, ethUsd: await ethUsd().catch(() => null) };
}

/** One stake by vault address, with the owner's view. */
export async function stakeView(vault, owner) {
  const entries = await call(STAKE_FACTORY, FACTORY_ABI, "allStakes");
  const e = entries.find((x) => lower(x.vault) === lower(vault));
  if (!e) throw new Error("no such stake");
  return stakeState({ ...e, token: lower(e.token), pool: lower(e.pool) }, owner);
}

/**
 * Plan a deposit. mode "one": a single coin, half swapped through the pool;
 * "both": ETH and token together, no swap. Returns the zap calldata, the
 * quote for the swapped half, price impact and what protects the user.
 */
export async function stakeQuote({ vault, mode = "one", asset = "eth", amount = 0n, tokenAmount = 0n, slippageBps = 100, from = null }) {
  const s = await stakeView(vault);
  const zap = await zapAddress();
  const token = s.token;
  const tokenIsIn = asset === "token";
  let quote = null, minOut = 0n, data, value = 0n, approve = null;
  if (mode === "both") {
    if (amount === 0n && tokenAmount === 0n) throw new Error("nothing to deposit");
    data = encodeFunctionData({ abi: ZAP_ABI, functionName: "zapBoth", args: [getAddress(vault), tokenAmount] });
    value = amount;
    if (tokenAmount > 0n) approve = { token: getAddress(token), spender: zap, amount: tokenAmount.toString() };
  } else {
    if (amount === 0n) throw new Error("nothing to deposit");
    const half = amount / 2n;
    const [tin, tout] = tokenIsIn ? [token, WETH] : [WETH, token];
    const q = await quotePath([tin, tout], [s.fee], half);
    if (!q) throw new Error("no quote for the swap leg");
    const sliver = half / 1000n;
    const ref = sliver > 0n ? await quotePath([tin, tout], [s.fee], sliver) : null;
    const impactBps = ref && ref.amountOut > 0n ? Math.max(0, Math.round((1 - (Number(q.amountOut) / Number(half)) / (Number(ref.amountOut) / Number(sliver))) * 10_000)) : null;
    minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    quote = { swapIn: half.toString(), swapOut: q.amountOut.toString(), minOut: minOut.toString(), priceImpactBps: impactBps };
    if (tokenIsIn) {
      data = encodeFunctionData({ abi: ZAP_ABI, functionName: "zapToken", args: [getAddress(vault), amount, minOut] });
      approve = { token: getAddress(token), spender: zap, amount: amount.toString() };
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
    pay: [...(value > 0n ? [{ asset: "eth", max: value }] : []), ...(approve ? [{ asset: approve.token, max: BigInt(approve.amount) }] : [])],
    mustNotRetain: [{ holder: zap, asset: "eth" }, { holder: zap, asset: getAddress(WETH) }, { holder: zap, asset: getAddress(token) }],
  });
  return {
    vault: s.vault, farm: s.farm, symbol: s.symbol, decimals: s.decimals, mode, asset, quote, slippageBps,
    ...check,
    tx: check.guard.ok ? { to: zap, data, value: value.toString(), approve } : null,
  };
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
  const wethIs0 = WETH.toLowerCase() < s.token.toLowerCase();
  const data = encodeFunctionData({
    abi: VAULT_ABI,
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
    vault: s.vault, symbol: s.symbol, decimals: s.decimals, shares: shares.toString(), slippageBps: Number(bps),
    expected: { weth: wethPart.toString(), token: tokenPart.toString() },
    minimum: { weth: minWeth.toString(), token: minToken.toString() },
    ...check,
    tx: check.guard.ok ? tx : null,
  };
}
export const claimCalldata = (farm) => ({ to: getAddress(farm), data: encodeFunctionData({ abi: FARM_ABI, functionName: "getReward" }) });
export const harvestCalldata = (vault) => ({ to: getAddress(vault), data: encodeFunctionData({ abi: VAULT_ABI, functionName: "harvest" }) });

/** Where a new stake for `token` would attach: its deepest ETH pool, and whether one already exists. */
export async function stakeCreatePlan(token) {
  token = lower(token);
  const pools = (await poolsForToken(token)).filter((p) => p.quote === WETH);
  if (!pools.length) throw new Error("this token has no Uniswap V3 pool against ETH yet");
  const pool = pools[0];
  const existing = await call(STAKE_FACTORY, FACTORY_ABI, "stakeForPool", [getAddress(pool.pool)]);
  const info = (await tradeTokens(STORE)).find((t) => t.address === token);
  return {
    token, symbol: info?.symbol ?? null, name: info?.name ?? null, pool: pool.pool, fee: pool.fee, liquidity: pool.liquidity,
    exists: lower(existing.vault) !== "0x0000000000000000000000000000000000000000" ? { vault: existing.vault, farm: existing.farm } : null,
    tx: { to: getAddress(STAKE_FACTORY), data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createStake", args: [getAddress(pool.pool)] }) },
  };
}
