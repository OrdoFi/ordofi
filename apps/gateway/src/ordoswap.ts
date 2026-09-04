/**
 * ordo_quoteSwap — the off-chain half of OrdoSwap (contracts/src/OrdoSwap.sol).
 *
 * The contract performs a swap and then, in the same transaction, runs the
 * arbitrage the swap opened and pays the surplus to the user. It does not
 * decide *which* arbitrage: that is a search, and searches belong off-chain
 * where they are free. This module runs it. Given the user's intended swap it
 * simulates the swap, tries every cross-tier cycle the swap could have opened
 * at a ladder of sizes, and returns the calldata for `swap(...)` with the most
 * profitable reclaim attached — or with none, when nothing beats the gas of
 * trying, which is the honest answer for most small swaps.
 *
 * WETH-in swaps are quoted through the contract's own `quote()`, one eth_call
 * per candidate, carrying the swap size as value from the WETH contract's
 * balance (it holds every wrapped ether, so the node lets the call spend it).
 * Token-in swaps need the user's token balance and approval to exist in the
 * simulated state, so they go through eth_simulateV1 from the user's address.
 */
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { FEES, QUOTER_V2, V3_FACTORY, ZERO_ADDRESS, encodePath } from "@ordofi/core/arb";
import { RpcError } from "./errors.js";

export const WETH: Hex = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG: Hex = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

export const ORDO_SWAP_ABI = parseAbi([
  "struct Reclaim { bytes path; uint256 amountIn; uint256 minProfit; }",
  "function swap(bytes path, uint256 amountIn, uint256 amountOutMinimum, address recipient, bool nativeOut, Reclaim reclaim) payable returns (uint256 amountOut, uint256 surplus)",
  "function quote(bytes path, uint256 amountIn, Reclaim reclaim) payable",
  "function float() view returns (uint256)",
  "function protocolBps() view returns (uint16)",
  "error QuoteResult(uint256 amountOut, uint256 reclaimProfit, bytes reclaimFailure)",
  "error BadPath()",
]);

const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const ERC20_ABI = parseAbi(["function approve(address, uint256) returns (bool)"]);

/** Gas a reclaim leg costs on top of the swap: two hops plus the WETH bookkeeping. Measured 180–230k on the fork. */
export const RECLAIM_GAS = 230_000n;
/** The reclaim only ships if the user's share clears its own gas by this factor. */
const WORTH_IT = 3n;
/** Sizes tried, as thousandths of the float. */
const LADDER_PERMILLE = [50n, 100n, 250n, 500n, 1000n];

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface SwapRequest {
  tokenIn: Hex;
  tokenOut: Hex;
  /** Fee tier of the pool the user is swapping through. */
  fee: number;
  amountIn: bigint;
  /** The user's slippage floor for their own swap. Passed through to the router. */
  amountOutMinimum: bigint;
  recipient: Hex;
  /** Pay the user in ETH; requires tokenOut == WETH. */
  nativeOut: boolean;
  /** Sender, needed to simulate a token-in swap from an address that holds the token. */
  from?: Hex;
}

export interface Reclaim {
  path: Hex;
  amountIn: bigint;
  minProfit: bigint;
  /** What the round trip returned above its input in simulation. */
  profit: bigint;
  label: string;
}

export interface SwapQuote {
  to: Hex;
  data: Hex;
  value: Hex;
  amountOut: Hex;
  /** Present when a reclaim is attached. */
  reclaim: null | {
    path: Hex;
    amountIn: Hex;
    minProfit: Hex;
    /** Simulated round-trip profit, before the split. */
    profit: Hex;
    /** What the user is expected to receive on top of amountOut. */
    surplusToUser: Hex;
    /** Which cycle: "USDG 100→3000" and so on. */
    label: string;
  };
  /** Why no reclaim is attached, when it is not. */
  note?: string;
}

export interface Cycle {
  path: Hex;
  label: string;
}

/**
 * The cycles a swap through `fee` on (base, token) could open, given the
 * tiers that exist. A buy of `token` makes it dear on `fee`: buy on another
 * tier, sell on `fee`. A sell of `token` makes it cheap on `fee`: buy on
 * `fee`, sell elsewhere. The USDG leg is for tokens whose depth is against
 * USDG rather than WETH — the tokenized stocks, mostly.
 */
export function candidateCycles(token: Hex, fee: number, buying: boolean, tiers: number[], usdgTiers: number[], wethUsdgTier: number | undefined, sym = token.slice(0, 8)): Cycle[] {
  const out: Cycle[] = [];
  for (const other of tiers) {
    if (other === fee) continue;
    const [inFee, outFee] = buying ? [other, fee] : [fee, other];
    out.push({ path: encodePath([WETH, token, WETH], [inFee, outFee]), label: `${sym} ${inFee}→${outFee}` });
  }
  if (wethUsdgTier !== undefined) {
    for (const tu of usdgTiers) {
      // buying: token is dear on WETH/token@fee → acquire via USDG, sell into fee
      // selling: token is cheap on WETH/token@fee → buy there, sell into USDG
      const path = buying
        ? encodePath([WETH, USDG, token, WETH], [wethUsdgTier, tu, fee])
        : encodePath([WETH, token, USDG, WETH], [fee, tu, wethUsdgTier]);
      out.push({ path, label: buying ? `USDG→${sym}@${tu}→WETH@${fee}` : `WETH@${fee}→${sym}→USDG@${tu}` });
    }
  }
  return out;
}

/**
 * Which tiers a pair has never changes once a pool exists, and a pool that
 * does not exist yet is rare enough to re-check on a slow clock. Without this
 * every quote paid twelve factory round trips before doing anything.
 */
const tierCache = new Map<string, { tiers: number[]; at: number }>();
const TIER_TTL_MS = 10 * 60_000;

async function tiersFor(rpc: Rpc, a: Hex, b: Hex): Promise<number[]> {
  const key = [a.toLowerCase(), b.toLowerCase()].sort().join(":");
  const hit = tierCache.get(key);
  if (hit && Date.now() - hit.at < TIER_TTL_MS) return hit.tiers;
  const tiers = await tiersUncached(rpc, a, b);
  tierCache.set(key, { tiers, at: Date.now() });
  return tiers;
}

async function tiersUncached(rpc: Rpc, a: Hex, b: Hex): Promise<number[]> {
  const hits = await Promise.all(
    FEES.map(async (fee) => {
      try {
        const out = (await rpc("eth_call", [
          { to: V3_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] }) },
          "latest",
        ])) as Hex;
        const pool = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: out }) as string;
        return pool.toLowerCase() === ZERO_ADDRESS ? null : fee;
      } catch {
        return null;
      }
    }),
  );
  return hits.filter((f): f is number => f !== null);
}

/** Values that change on the order of blocks, shared by every quote in flight for a few seconds. */
const briefCache = new Map<string, { v: Promise<unknown>; at: number }>();
function brief(key: string, load: () => Promise<unknown>, ttlMs = 3_000): Promise<unknown> {
  const hit = briefCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = load();
  briefCache.set(key, { v, at: Date.now() });
  v.catch(() => briefCache.delete(key));
  return v;
}

/** The ladder for this float: distinct, non-zero, ascending. */
export function sizeLadder(float: bigint, cap: bigint): bigint[] {
  const max = float < cap ? float : cap;
  const sizes = LADDER_PERMILLE.map((p) => (max * p) / 1000n).filter((s) => s > 0n);
  return [...new Set(sizes.map(String))].map(BigInt);
}

/** Decode a `quote()` revert into its answer, or null when it reverted with something else. */
export function decodeQuote(revertData: Hex): { amountOut: bigint; profit: bigint; failed: boolean } | null {
  try {
    const d = decodeErrorResult({ abi: ORDO_SWAP_ABI, data: revertData });
    if (d.errorName !== "QuoteResult") return null;
    const [amountOut, profit, failure] = d.args as [bigint, bigint, Hex];
    return { amountOut, profit, failed: failure !== "0x" && failure.length > 2 };
  } catch {
    return null;
  }
}

/** The revert payload an eth_call error carries, wherever the upstream put it. */
function revertBytes(err: unknown): Hex | null {
  const e = err as { data?: unknown; message?: string };
  const candidates: unknown[] = [e?.data, (e?.data as { data?: unknown })?.data];
  for (const c of candidates) if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c as Hex;
  const m = /(0x[0-9a-fA-F]{8,})/.exec(e?.message ?? "");
  return m ? (m[1] as Hex) : null;
}

/**
 * Pick the reclaim that is actually worth attaching. `profits` is per
 * (cycle, size) as simulated against the post-swap state.
 */
export function chooseReclaim(
  results: { cycle: Cycle; size: bigint; profit: bigint }[],
  gasPrice: bigint,
  protocolBps: bigint,
): Reclaim | null {
  let best: { cycle: Cycle; size: bigint; profit: bigint } | null = null;
  for (const r of results) if (r.profit > 0n && (!best || r.profit > best.profit)) best = r;
  if (!best) return null;
  const gas = RECLAIM_GAS * gasPrice;
  const userShare = (best.profit * (10_000n - protocolBps)) / 10_000n;
  if (userShare < gas * WORTH_IT) return null;
  // Ship if at least this much survives to inclusion: enough that the user's
  // share still covers the gas of the leg with room, otherwise skip cleanly.
  const floor = (gas * 10_000n) / (10_000n - protocolBps);
  const minProfit = best.profit / 2n > floor ? best.profit / 2n : floor;
  return { path: best.cycle.path, amountIn: best.size, minProfit, profit: best.profit, label: best.cycle.label };
}

export interface QuoteDeps {
  rpc: Rpc;
  ordoSwap: Hex;
  /** Where the simulated value for a WETH-in quote is spent from. */
  valueSource?: Hex;
}

/**
 * The quote. Throws RpcError on bad input; never throws because no reclaim
 * exists — that is a normal answer with `reclaim: null` and a note.
 */
export async function quoteSwap(req: SwapRequest, deps: QuoteDeps): Promise<SwapQuote> {
  const { rpc, ordoSwap } = deps;
  const tokenIn = req.tokenIn.toLowerCase() as Hex;
  const tokenOut = req.tokenOut.toLowerCase() as Hex;
  if (tokenIn === tokenOut) throw new RpcError(-32602, "ordo_quoteSwap: tokenIn and tokenOut are the same");
  if (req.amountIn <= 0n) throw new RpcError(-32602, "ordo_quoteSwap: amountIn must be positive");
  if (!FEES.includes(req.fee)) throw new RpcError(-32602, `ordo_quoteSwap: fee must be one of ${FEES.join(", ")}`);
  if (req.nativeOut && tokenOut !== WETH) throw new RpcError(-32602, "ordo_quoteSwap: nativeOut requires tokenOut to be WETH");
  const wethIn = tokenIn === WETH;
  const wethOut = tokenOut === WETH;
  if (!wethIn && !wethOut) {
    // A token-to-token swap opens gaps on two pairs at once; v1 reclaims only WETH-legged swaps.
    return plain(req, ordoSwap, null, "reclaim is only searched for swaps with WETH on one side (v1)");
  }
  if (!wethIn && !req.from) throw new RpcError(-32602, "ordo_quoteSwap: token-in swaps need `from` (the sender) to simulate");

  const token = wethIn ? tokenOut : tokenIn;
  const userPath = encodePath([tokenIn, tokenOut], [req.fee]);

  const [tiers, usdgTiers, wethUsdgTiers, floatHex, bpsHex, gasPriceHex] = await Promise.all([
    tiersFor(rpc, WETH, token),
    token === USDG ? Promise.resolve([] as number[]) : tiersFor(rpc, USDG, token),
    tiersFor(rpc, WETH, USDG),
    brief(`float:${ordoSwap}`, () => rpc("eth_call", [{ to: ordoSwap, data: encodeFunctionData({ abi: ORDO_SWAP_ABI, functionName: "float" }) }, "latest"])),
    brief(`bps:${ordoSwap}`, () => rpc("eth_call", [{ to: ordoSwap, data: encodeFunctionData({ abi: ORDO_SWAP_ABI, functionName: "protocolBps" }) }, "latest"])),
    brief("gasPrice", () => rpc("eth_gasPrice", [])),
  ]);
  if (!tiers.includes(req.fee)) throw new RpcError(-32602, `ordo_quoteSwap: no ${req.fee} pool for this pair`);
  const float = BigInt(floatHex as string);
  const protocolBps = BigInt(bpsHex as string);
  const gasPrice = BigInt(gasPriceHex as string);
  const cycles = candidateCycles(token, req.fee, wethIn, tiers, usdgTiers, wethUsdgTiers[0]);
  // Never more than the swap itself: past that the reclaim is trading the pool, not closing the gap.
  const sizes = sizeLadder(float, req.amountIn);
  if (cycles.length === 0 || sizes.length === 0) {
    return plain(req, ordoSwap, null, cycles.length === 0 ? "this pair has one tier; a swap on it opens no cross-tier gap" : "reclaim float is empty");
  }

  const results = wethIn
    ? await quoteWethIn(rpc, ordoSwap, deps.valueSource ?? WETH, userPath, req.amountIn, cycles, sizes)
    : await quoteTokenIn(rpc, ordoSwap, req.from!, tokenIn, userPath, req.amountIn, req.recipient, req.nativeOut, cycles, sizes);

  const reclaim = chooseReclaim(results.reclaims, gasPrice, protocolBps);
  if (!reclaim) {
    const best = results.reclaims.reduce((m, r) => (r.profit > m ? r.profit : m), 0n);
    return plain(
      req,
      ordoSwap,
      results.amountOut,
      results.note ?? (best > 0n ? "the gap this swap opens does not cover the gas of closing it" : "this swap opens no cross-tier gap"),
    );
  }
  const surplusToUser = (reclaim.profit * (10_000n - protocolBps)) / 10_000n;
  return {
    to: ordoSwap,
    data: encodeFunctionData({
      abi: ORDO_SWAP_ABI,
      functionName: "swap",
      args: [userPath, req.amountIn, req.amountOutMinimum, req.recipient, req.nativeOut, { path: reclaim.path, amountIn: reclaim.amountIn, minProfit: reclaim.minProfit }],
    }),
    value: wethIn ? hex(req.amountIn) : "0x0",
    amountOut: hex(results.amountOut),
    reclaim: {
      path: reclaim.path,
      amountIn: hex(reclaim.amountIn),
      minProfit: hex(reclaim.minProfit),
      profit: hex(reclaim.profit),
      surplusToUser: hex(surplusToUser),
      label: reclaim.label,
    },
  };
}

function plain(req: SwapRequest, ordoSwap: Hex, amountOut: bigint | null, note: string): SwapQuote {
  const userPath = encodePath([req.tokenIn, req.tokenOut], [req.fee]);
  return {
    to: ordoSwap,
    data: encodeFunctionData({
      abi: ORDO_SWAP_ABI,
      functionName: "swap",
      args: [userPath, req.amountIn, req.amountOutMinimum, req.recipient, req.nativeOut, { path: "0x", amountIn: 0n, minProfit: 0n }],
    }),
    value: req.tokenIn.toLowerCase() === WETH ? hex(req.amountIn) : "0x0",
    amountOut: amountOut === null ? "0x0" : hex(amountOut),
    reclaim: null,
    note,
  };
}

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;

interface Searched {
  amountOut: bigint;
  reclaims: { cycle: Cycle; size: bigint; profit: bigint }[];
  /** Why the search could not run, when it could not. */
  note?: string;
}

/** WETH-in: one `quote()` eth_call per (cycle, size), each with the swap's value attached. */
async function quoteWethIn(rpc: Rpc, ordoSwap: Hex, valueSource: Hex, userPath: Hex, amountIn: bigint, cycles: Cycle[], sizes: bigint[]): Promise<Searched> {
  const tasks = cycles.flatMap((cycle) => sizes.map((size) => ({ cycle, size })));
  // Plus one with no reclaim, so amountOut is known even if every reclaim fails.
  tasks.unshift({ cycle: { path: "0x", label: "none" }, size: 0n });
  let amountOut = 0n;
  const reclaims: Searched["reclaims"] = [];
  await Promise.all(
    tasks.map(async ({ cycle, size }) => {
      const data = encodeFunctionData({
        abi: ORDO_SWAP_ABI,
        functionName: "quote",
        args: [userPath, amountIn, { path: cycle.path, amountIn: size, minProfit: 0n }],
      });
      let decoded: ReturnType<typeof decodeQuote> = null;
      try {
        await rpc("eth_call", [{ from: valueSource, to: ordoSwap, data, value: hex(amountIn) }, "latest"]);
      } catch (e) {
        const bytes = revertBytes(e);
        decoded = bytes ? decodeQuote(bytes) : null;
      }
      if (!decoded) return;
      if (decoded.amountOut > 0n) amountOut = decoded.amountOut;
      if (size > 0n && !decoded.failed) reclaims.push({ cycle, size, profit: decoded.profit });
    }),
  );
  return { amountOut, reclaims };
}

/**
 * Token-in: eth_simulateV1 from the user — approve, swap without reclaim, then
 * every candidate through the quoter against the state the swap left behind.
 */
async function quoteTokenIn(
  rpc: Rpc,
  ordoSwap: Hex,
  from: Hex,
  tokenIn: Hex,
  userPath: Hex,
  amountIn: bigint,
  recipient: Hex,
  nativeOut: boolean,
  cycles: Cycle[],
  sizes: bigint[],
): Promise<Searched> {
  const probes = cycles.flatMap((cycle) => sizes.map((size) => ({ cycle, size })));
  const calls = [
    { from, to: tokenIn, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ordoSwap, amountIn] }) },
    {
      from,
      to: ordoSwap,
      data: encodeFunctionData({
        abi: ORDO_SWAP_ABI,
        functionName: "swap",
        args: [userPath, amountIn, 0n, recipient, nativeOut, { path: "0x", amountIn: 0n, minProfit: 0n }],
      }),
    },
    ...probes.map(({ cycle, size }) => ({
      from: ordoSwap,
      to: QUOTER_V2,
      data: encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInput", args: [cycle.path, size] }),
    })),
  ];
  let blocks: any;
  try {
    blocks = await rpc("eth_simulateV1", [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, "latest"]);
  } catch (e) {
    throw new RpcError(-32000, `ordo_quoteSwap: could not simulate the swap — ${(e as Error).message}`);
  }
  const results: { status?: string; returnData?: Hex; error?: { message?: string } }[] = blocks?.[0]?.calls ?? [];
  const swapRes = results[1];
  if (!swapRes || swapRes.status !== "0x1") {
    // The sender cannot make this swap right now — usually no balance or no
    // approval yet, which is the state every widget is in before the wallet is
    // connected. Still answer what the swap would return, from the quoter, so
    // the caller can show a price; the reclaim search needs the real state.
    const out = await rpc("eth_call", [
      { to: QUOTER_V2, data: encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInput", args: [userPath, amountIn] }) },
      "latest",
    ]).catch(() => null);
    if (!out) throw new RpcError(-32000, `ordo: the swap itself would revert — ${swapRes?.error?.message ?? "unknown reason"}`, { ordoProtected: true });
    const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInput", data: out as Hex }) as [bigint, bigint[], number[], bigint];
    return { amountOut, reclaims: [], note: "connect a wallet that holds the token and has approved the contract to see what would come back" };
  }
  const [amountOut] = decodeFunctionResult({ abi: ORDO_SWAP_ABI, functionName: "swap", data: swapRes.returnData! }) as [bigint, bigint];
  const reclaims: Searched["reclaims"] = [];
  probes.forEach(({ cycle, size }, i) => {
    const r = results[i + 2];
    if (!r || r.status !== "0x1" || !r.returnData) return;
    try {
      const [out] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInput", data: r.returnData }) as [bigint, bigint[], number[], bigint];
      if (out > size) reclaims.push({ cycle, size, profit: out - size });
    } catch {
      /* unquotable at this size */
    }
  });
  return { amountOut, reclaims };
}
