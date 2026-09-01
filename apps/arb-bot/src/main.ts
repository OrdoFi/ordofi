import { privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  decodeFunctionResult,
  encodePacked,
  formatEther,
  parseEther,
  type Hex,
} from "viem";
import { normalizePrivateKey, rpcFetch } from "@ordofi/core";

/**
 * OrdoFi house arbitrage bot — the profit engine that seeds the loop.
 *
 * It hunts cyclic dislocations: the same pair priced differently across fee
 * tiers, so a round trip WETH -> token -> WETH through two tiers comes back
 * with more WETH than it started. Every candidate is *simulated* against
 * QuoterV2 for free (eth_call, no gas, no state change); a trade is only sent
 * when the simulated return clears gas plus a margin.
 *
 * Safety is structural, not hopeful. Execution is one atomic SwapRouter02
 * multicall: exactInput with amountOutMinimum = principal + margin, then
 * unwrapWETH9 back to native ETH. If the edge evaporated between simulation
 * and inclusion — the usual case on a fast chain — the swap reverts, the whole
 * multicall reverts, and the only cost is gas. Principal is never at risk.
 *
 * It deliberately does NOT touch the auction: this is a plain searcher trading
 * its own capital, kept on its own wallet so its nonces never collide with the
 * house bidding bot. When our own node comes online the lower latency is what
 * turns simulated edges into won ones; until then, expect most edges to be
 * taken by colocated bots first (a revert, a few cents of gas).
 *
 * Env:
 *   ORDO_ARB_KEY          private key of the arb wallet (required to trade)
 *   ORDO_RPC_URLS         upstreams (rpcFetch rotates on throttle/challenge)
 *   ORDO_ARB_MIN_PROFIT_ETH   floor net profit to fire (default 0.000004)
 *   ORDO_ARB_GAS_RESERVE_ETH  ETH kept back for gas, never traded (default 0.0008)
 *   ORDO_ARB_MAX_NOTIONAL_ETH cap per trade (default: whole tradable balance)
 *   ORDO_ARB_INTERVAL_MS      scan cadence (default 4000)
 */

const KEY = normalizePrivateKey(process.env.ORDO_ARB_KEY, "ORDO_ARB_KEY");
if (!KEY) {
  console.error("[arb] ORDO_ARB_KEY is unset — nothing to trade with. Exiting.");
  process.exit(1);
}
const account = privateKeyToAccount(KEY);

const CHAIN_ID = 4663;
const WETH: Hex = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG: Hex = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const V3_FACTORY: Hex = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const QUOTER_V2: Hex = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const ROUTER: Hex = "0xcaf681a66d020601342297493863e78c959e5cb2"; // SwapRouter02
const MSG_SENDER: Hex = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS: Hex = "0x0000000000000000000000000000000000000002";
const ZERO = "0x0000000000000000000000000000000000000000";
const FEES = [100, 500, 3000, 10000];

const SELF = process.env.ORDO_SELF_URL ?? "http://web:3000";
const MIN_PROFIT = parseEther(process.env.ORDO_ARB_MIN_PROFIT_ETH ?? "0.000004");
const GAS_RESERVE = parseEther(process.env.ORDO_ARB_GAS_RESERVE_ETH ?? "0.0008");
const MAX_NOTIONAL = process.env.ORDO_ARB_MAX_NOTIONAL_ETH
  ? parseEther(process.env.ORDO_ARB_MAX_NOTIONAL_ETH)
  : null;
const INTERVAL_MS = Number(process.env.ORDO_ARB_INTERVAL_MS ?? 8000);

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;
const QUOTER_ABI = [
  {
    type: "function", name: "quoteExactInput", stateMutability: "nonpayable",
    inputs: [{ type: "bytes" }, { type: "uint256" }],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160[]" }, { type: "uint32[]" }, { type: "uint256" },
    ],
  },
] as const;
const ROUTER_ABI = [
  {
    type: "function", name: "multicall", stateMutability: "payable",
    inputs: [{ type: "uint256" }, { type: "bytes[]" }], outputs: [{ type: "bytes[]" }],
  },
  {
    type: "function", name: "exactInput", stateMutability: "payable",
    inputs: [{ type: "tuple", name: "params", components: [
      { type: "bytes", name: "path" }, { type: "address", name: "recipient" },
      { type: "uint256", name: "amountIn" }, { type: "uint256", name: "amountOutMinimum" },
    ] }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [] },
] as const;

async function ethCall(to: string, data: Hex): Promise<Hex> {
  return (await rpcFetch("eth_call", [{ to, data }, "latest"])) as Hex;
}

function encodePath(tokens: Hex[], fees: number[]): Hex {
  const types: string[] = [];
  const values: (Hex | number)[] = [];
  tokens.forEach((t, i) => {
    types.push("address");
    values.push(t);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  });
  return encodePacked(types as never, values as never);
}

// --- discovery: which cycles even exist -------------------------------------

interface Cycle {
  label: string;
  tokens: Hex[]; // starts and ends at WETH
  fees: number[]; // one per hop, so tokens.length === fees.length + 1
}

async function poolTiers(a: Hex, b: Hex): Promise<number[]> {
  const tiers: number[] = [];
  for (const fee of FEES) {
    try {
      const out = await ethCall(V3_FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] }));
      if ((decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: out }) as string).toLowerCase() !== ZERO) tiers.push(fee);
    } catch { /* no pool at this tier */ }
  }
  return tiers;
}

/**
 * Two families of WETH-closed cycles:
 *   cross-tier   WETH -fA-> M -fB-> WETH        (fast, efficient, rarely open)
 *   triangular   WETH -> USDG -> M -> WETH       (thinner pools, more often open)
 * The triangular legs go through USDG because that is where the stock tokens
 * actually have depth; the reverse direction is included since dislocations
 * are one-sided.
 */
async function discoverCycles(): Promise<Cycle[]> {
  const universe = await candidateMids();
  const cycles: Cycle[] = [];
  const wethUsdgTiers = await poolTiers(WETH, USDG);
  const wu = wethUsdgTiers[0]; // deepest-listed WETH/USDG tier for the shared leg

  for (const { address, symbol } of universe) {
    const wethTiers = await poolTiers(WETH, address);

    for (const fA of wethTiers) {
      for (const fB of wethTiers) {
        if (fA !== fB) cycles.push({ label: `${symbol} ${fA}/${fB}`, tokens: [WETH, address, WETH], fees: [fA, fB] });
      }
    }

    if (address === USDG || wu === undefined || wethTiers.length === 0) continue;
    const usdgTiers = await poolTiers(USDG, address);
    for (const fu of usdgTiers) {
      for (const fw of wethTiers) {
        cycles.push({ label: `WETH>USDG>${symbol}>WETH ${wu}/${fu}/${fw}`, tokens: [WETH, USDG, address, WETH], fees: [wu, fu, fw] });
        cycles.push({ label: `WETH>${symbol}>USDG>WETH ${fw}/${fu}/${wu}`, tokens: [WETH, address, USDG, WETH], fees: [fw, fu, wu] });
      }
    }
  }
  return cycles;
}

/** USDG plus the tokens our own endpoint reports actively trading. */
async function candidateMids(): Promise<{ address: Hex; symbol: string }[]> {
  const out = new Map<Hex, string>();
  out.set(USDG, "USDG");
  for (const url of [`${SELF}/api/trade/tokens`, "https://app.ordofi.network/api/trade/tokens"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) continue;
      const list = (await r.json()) as { address?: string; symbol?: string; active?: boolean }[];
      for (const t of list) {
        const a = (t.address ?? "").toLowerCase();
        // Only the actively-traded set: cycles through dead pools waste quotes.
        if (t.active && /^0x[0-9a-f]{40}$/.test(a) && a !== WETH) out.set(a as Hex, (t.symbol ?? "?").slice(0, 10));
      }
      break;
    } catch { /* try the next source */ }
  }
  return [...out].map(([address, symbol]) => ({ address, symbol }));
}

// --- simulation --------------------------------------------------------------

async function quoteCycle(c: Cycle, amountIn: bigint): Promise<bigint | null> {
  const path = encodePath(c.tokens, c.fees);
  try {
    const out = await ethCall(QUOTER_V2, encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInput", args: [path, amountIn] }));
    const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInput", data: out }) as [bigint, bigint[], number[], bigint];
    return amountOut;
  } catch {
    return null; // no liquidity along this path right now
  }
}

// --- chain state -------------------------------------------------------------

let maxFeePerGas = 2_000_000_000n;
async function refreshGas(): Promise<void> {
  try {
    maxFeePerGas = BigInt((await rpcFetch("eth_gasPrice", [])) as string) * 2n;
  } catch { /* keep the last value */ }
}

async function tradableBalance(): Promise<bigint> {
  const bal = BigInt((await rpcFetch("eth_getBalance", [account.address, "latest"])) as string);
  const free = bal > GAS_RESERVE ? bal - GAS_RESERVE : 0n;
  return MAX_NOTIONAL && free > MAX_NOTIONAL ? MAX_NOTIONAL : free;
}

/** A few sizes up to the budget; price impact makes the best size interior. */
function sizeLadder(budget: bigint): bigint[] {
  const sizes: bigint[] = [];
  for (const frac of [8n, 3n]) {
    const s = budget / frac;
    if (s > 0n) sizes.push(s);
  }
  if (budget > 0n) sizes.push(budget);
  return [...new Set(sizes.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
}

// --- execution ---------------------------------------------------------------

function buildTx(c: Cycle, amountIn: bigint, minReturn: bigint) {
  const path = encodePath(c.tokens, c.fees);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  const swap = encodeFunctionData({
    abi: ROUTER_ABI, functionName: "exactInput",
    args: [{ path, recipient: ADDRESS_THIS, amountIn, amountOutMinimum: minReturn }],
  });
  const unwrap = encodeFunctionData({ abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [minReturn, MSG_SENDER] });
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [deadline, [swap, unwrap]] });
}

let firing = false;

async function tick(cycles: Cycle[]): Promise<void> {
  if (firing) return;
  const budget = await tradableBalance();
  if (budget < parseEther("0.0002")) return; // dust; nothing worth trying

  const sizes = sizeLadder(budget);
  let best: { c: Cycle; amountIn: bigint; out: bigint; gross: bigint } | null = null;

  for (const c of cycles) {
    for (const amountIn of sizes) {
      const out = await quoteCycle(c, amountIn);
      if (out == null || out <= amountIn) continue;
      const gross = out - amountIn;
      if (!best || gross > best.gross) best = { c, amountIn, out, gross };
    }
  }
  if (!best) return;

  // Price the real transaction. eth_estimateGas double-checks it would not
  // revert *and* gives the gas to subtract from the edge; a revert here means
  // the opportunity is already gone.
  const minReturn = best.amountIn + MIN_PROFIT;
  const data = buildTx(best.c, best.amountIn, minReturn);
  const value = "0x" + best.amountIn.toString(16);
  let gas: bigint;
  try {
    const g = (await rpcFetch("eth_estimateGas", [{ from: account.address, to: ROUTER, data, value }])) as string;
    gas = (BigInt(g) * 5n) / 4n; // 25% headroom over the estimate
  } catch {
    return; // would revert — edge taken, or too thin for the min-return guard
  }
  const gasCost = gas * maxFeePerGas;
  const net = best.gross - gasCost;
  if (net < MIN_PROFIT) {
    console.log(`[arb] pass ${best.c.label}: gross ${formatEther(best.gross)} ETH < gas ${formatEther(gasCost)} + floor`);
    return;
  }

  firing = true;
  try {
    const nonce = parseInt((await rpcFetch("eth_getTransactionCount", [account.address, "pending"])) as string, 16);
    const raw = await account.signTransaction({
      chainId: CHAIN_ID, to: ROUTER as Hex, data: data as Hex, value: best.amountIn,
      gas, maxFeePerGas, maxPriorityFeePerGas: 0n, nonce, type: "eip1559",
    });
    const hash = (await rpcFetch("eth_sendRawTransaction", [raw])) as string;
    console.log(`[arb] FIRING ${best.c.label} size ${formatEther(best.amountIn)} ETH · sim net ${formatEther(net)} ETH · ${hash}`);
    await confirm(hash, best.amountIn);
  } catch (e) {
    console.warn(`[arb] send failed: ${(e as Error).message}`);
  } finally {
    firing = false;
  }
}

async function confirm(hash: string, amountIn: bigint): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const rec = (await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null)) as
      | { status: string; gasUsed: string; effectiveGasPrice?: string }
      | null;
    if (!rec) continue;
    const gasUsed = BigInt(rec.gasUsed);
    const gasPrice = BigInt(rec.effectiveGasPrice ?? maxFeePerGas);
    if (rec.status === "0x1") {
      console.log(`[arb] WON ${hash} — round trip cleared (gas ${formatEther(gasUsed * gasPrice)} ETH)`);
    } else {
      console.log(`[arb] reverted ${hash} — edge taken first, cost gas ${formatEther(gasUsed * gasPrice)} ETH (principal safe)`);
    }
    return;
  }
  console.warn(`[arb] ${hash} unconfirmed in 30s`);
}

// --- main --------------------------------------------------------------------

console.log(`OrdoFi arb bot | ${account.address}`);
let cycles = await discoverCycles();
const midCount = new Set(cycles.map((c) => c.tokens.join(">"))).size;
console.log(`OrdoFi arb bot | ${cycles.length} cycles (cross-tier + triangular) across ${midCount} routes`);
console.log(`OrdoFi arb bot | min net ${formatEther(MIN_PROFIT)} ETH · gas reserve ${formatEther(GAS_RESERVE)} ETH · scan ${INTERVAL_MS}ms`);

await refreshGas();
setInterval(() => { refreshGas().catch(() => {}); }, 20_000);
// Pools come and go; re-discover occasionally without blocking the scan loop.
setInterval(() => { discoverCycles().then((c) => { if (c.length) cycles = c; }).catch(() => {}); }, 600_000);

if (cycles.length === 0) {
  console.warn("[arb] no cross-tier cycles found — the arb surface is empty right now; will re-scan every 10 min");
}
setInterval(() => { tick(cycles).catch((e) => console.warn(`[arb] tick: ${(e as Error).message}`)); }, INTERVAL_MS);
