import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeFunctionData, decodeFunctionResult, formatEther, parseEther, type Hex } from "viem";
import { WETH, normalizePrivateKey, rpcFetch } from "@ordofi/core";
import { buildCycleSwap } from "@ordofi/core/arb";
import { ROUTER } from "@ordofi/core/router";
import { OrdoSearcher } from "@ordofi/sdk";
import { CycleCache, evaluate, type Sized, type StrategyConfig } from "./strategy.js";

/**
 * Reference OrdoFi searcher bot — also the house bot that keeps the auction
 * from ever being empty, so the first app to route flow meets a live market
 * instead of a room with the lights off.
 *
 * The strategy is deliberately naive and deliberately honest: bid a small
 * fixed amount on anything that touches a pool, with a self-transfer as the
 * backrun placeholder. A real searcher replaces the decision logic with
 * simulation and bids up to expected profit; this file is the canonical
 * example of everything else — the EIP-712 bid flow, bond upkeep, and the
 * mainnet lessons (Arbitrum intrinsic gas includes an L1 component, so 21000
 * is a rejection; nonces come from the chain, not from zero; and nothing
 * network-bound belongs inside the 200ms bid window).
 *
 * Env:
 *   ORDO_AUCTION_WS          wss://auction.ordofi.network/searcher (default ws://localhost:8548/searcher)
 *   ORDO_SETTLEMENT_ADDRESS  deployed OrdoSettlement (EIP-712 domain + bonding)
 *   SEARCHER_KEY             searcher private key (default: ephemeral, for testing)
 *   ORDO_MAX_BID_ETH         max bid per opportunity (default 0.001)
 *   ORDO_BOND_TARGET_ETH     bond to maintain on-chain (default 2x max bid)
 */

const CHAIN_ID = 4663;
const AUCTION_WS = process.env.ORDO_AUCTION_WS ?? "ws://localhost:8548/searcher";
const SETTLEMENT = (process.env.ORDO_SETTLEMENT_ADDRESS ?? "") as Hex;
const KEY = normalizePrivateKey(process.env.SEARCHER_KEY, "SEARCHER_KEY") ?? generatePrivateKey();
const MAX_BID = parseEther(process.env.ORDO_MAX_BID_ETH ?? "0.001");
const BOND_TARGET = process.env.ORDO_BOND_TARGET_ETH
  ? parseEther(process.env.ORDO_BOND_TARGET_ETH)
  : MAX_BID * 2n;
/** Capital for one round trip. Kept apart from the bond, which is collateral, not stock. */
const TRADE_BUDGET = parseEther(process.env.ORDO_SEARCHER_BUDGET_ETH ?? "0.02");
/** ETH the wallet keeps for gas and never trades. */
const GAS_RESERVE = parseEther(process.env.ORDO_SEARCHER_GAS_RESERVE_ETH ?? "0.002");
const MIN_PROFIT = parseEther(process.env.ORDO_SEARCHER_MIN_PROFIT_ETH ?? "0.000004");
/** Share of the net edge offered to the auction; the rest covers races we lose. */
const BID_SHARE_PCT = BigInt(process.env.ORDO_SEARCHER_BID_SHARE_PCT ?? "70");
/** Quoting stops here, well inside the 200 ms window, so the bid still arrives. */
const EVAL_BUDGET_MS = Number(process.env.ORDO_SEARCHER_EVAL_MS ?? 120);

const account = privateKeyToAccount(KEY);

const BOND_ABI = [
  {
    type: "function",
    name: "bond",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// --- chain state, refreshed outside the bid window ---------------------------

let nonce = 0;
let maxFeePerGas = 2_000_000_000n;
let gasLimit = 60_000n;
/** A two-hop V3 round trip, not a transfer; measured rather than guessed would be better, but not inside the window. */
let swapGasLimit = 400_000n;
let tradeBudget = 0n;

async function refreshChainState(): Promise<void> {
  const [nonceHex, gasPriceHex, gasHex, balanceHex] = await Promise.all([
    rpcFetch("eth_getTransactionCount", [account.address, "pending"]),
    rpcFetch("eth_gasPrice", []),
    rpcFetch("eth_estimateGas", [{ from: account.address, to: account.address, value: "0x0" }]),
    rpcFetch("eth_getBalance", [account.address, "latest"]),
  ]);
  nonce = parseInt(nonceHex as string, 16);
  maxFeePerGas = BigInt(gasPriceHex as string) * 2n;
  // Headroom over the estimate: the L1 data component drifts with calldata prices.
  gasLimit = (BigInt(gasHex as string) * 3n) / 2n;

  // What the bot may actually put into a trade: its balance, less the gas it
  // must keep and the bond it must maintain, capped by the configured budget.
  const balance = BigInt(balanceHex as string);
  const reserved = GAS_RESERVE + BOND_TARGET;
  const free = balance > reserved ? balance - reserved : 0n;
  tradeBudget = free > TRADE_BUDGET ? TRADE_BUDGET : free;
}

/** What one backrun is expected to cost in gas, at the gas price we last saw. */
function gasCostWei(): bigint {
  return swapGasLimit * maxFeePerGas;
}

/**
 * The backrun itself: the round trip, signed, ready for the auction to place
 * behind the user's transaction. `amountOutMinimum` is the principal plus the
 * margin we did not bid away, so if the edge is gone by inclusion — the usual
 * outcome — the swap reverts and the only loss is gas.
 */
async function signedBackrun(best: Sized, bidWei: bigint): Promise<Hex> {
  const minReturn = best.amountIn + (best.grossWei - bidWei) / 2n;
  return account.signTransaction({
    chainId: CHAIN_ID,
    to: ROUTER,
    value: best.amountIn,
    data: buildCycleSwap(best.cycle, best.amountIn, minReturn),
    gas: swapGasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    nonce: nonce++,
    type: "eip1559",
  });
}

// --- bond upkeep --------------------------------------------------------------

let warnedBroke = false;

async function bondBalance(): Promise<bigint> {
  const data = encodeFunctionData({ abi: BOND_ABI, functionName: "bond", args: [account.address] });
  const out = (await rpcFetch("eth_call", [{ to: SETTLEMENT, data }, "latest"])) as Hex;
  return decodeFunctionResult({ abi: BOND_ABI, functionName: "bond", data: out }) as bigint;
}

/**
 * Keeps enough collateral on-chain that bond gating accepts our bids. A plain
 * transfer to the contract bonds via receive(); losing auctions costs nothing,
 * winning debits the clearing price from this balance.
 */
async function ensureBond(): Promise<void> {
  if (!SETTLEMENT) return;
  const bond = await bondBalance();
  if (bond >= BOND_TARGET) return;

  const topUp = BOND_TARGET - bond;
  const balanceHex = (await rpcFetch("eth_getBalance", [account.address, "latest"])) as string;
  const balance = BigInt(balanceHex);

  // A wallet that cannot cover the top-up is a funding problem, not a fault:
  // say so once and carry on. Estimating the bond transaction anyway throws
  // "insufficient funds", which at boot used to kill the process — a bot that
  // exits because it is poor cannot even report that it is poor.
  if (balance <= topUp) {
    if (!warnedBroke) {
      warnedBroke = true;
      console.warn(
        `[bot] bond is ${formatEther(bond)} ETH, target ${formatEther(BOND_TARGET)}, and the wallet holds ${formatEther(balance)} ETH — ` +
          `not enough to top up. Bids will be refused by bond gating until ${account.address} is funded.`,
      );
    }
    return;
  }
  warnedBroke = false;

  // Bonding runs OrdoSettlement.receive(), which writes storage. The
  // self-transfer estimate is nowhere near enough: reusing it sent three
  // transactions that each burned their whole 31,500 gas limit and reverted,
  // leaving the bond at zero while the wallet drained.
  const bondGasHex = (await rpcFetch("eth_estimateGas", [
    { from: account.address, to: SETTLEMENT, value: "0x" + topUp.toString(16) },
  ])) as string;
  const bondGas = (BigInt(bondGasHex) * 3n) / 2n;

  const gasBudget = bondGas * maxFeePerGas;
  if (balance < topUp + gasBudget) {
    console.warn(
      `[bot] bond is ${formatEther(bond)} ETH (target ${formatEther(BOND_TARGET)}) but the wallet ` +
        `holds only ${formatEther(balance)} ETH — fund ${account.address} to keep bidding`,
    );
    return;
  }

  const raw = await account.signTransaction({
    chainId: 4663,
    to: SETTLEMENT,
    value: topUp,
    gas: bondGas,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    nonce: nonce++,
    type: "eip1559",
  });
  const hash = (await rpcFetch("eth_sendRawTransaction", [raw])) as string;

  // Confirm rather than assume. A silently reverting bond looks identical to
  // a pending one from the next loop's point of view, so the bot just retries
  // forever and pays gas each time.
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const receipt = (await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null)) as
      | { status: string; gasUsed: string }
      | null;
    if (!receipt) continue;
    if (receipt.status === "0x1") {
      console.log(`[bot] bonded ${formatEther(topUp)} ETH — ${hash}`);
    } else {
      console.error(`[bot] bond REVERTED (gas used ${parseInt(receipt.gasUsed, 16)}) — ${hash}`);
    }
    return;
  }
  console.warn(`[bot] bond ${hash} not confirmed within 15s; will re-check next cycle`);
}

// --- strategy ------------------------------------------------------------------

const rpcCall = async (to: string, data: Hex): Promise<Hex> =>
  (await rpcFetch("eth_call", [{ to, data }, "latest"])) as Hex;

const cycleCache = new CycleCache(rpcCall, WETH as Hex);

/** Rebuilt per opportunity: gas price and the tradable balance both move. */
const strategy = (): StrategyConfig => ({
  base: WETH as Hex,
  maxBidWei: MAX_BID,
  budgetWei: tradeBudget,
  gasCostWei: gasCostWei(),
  minProfitWei: MIN_PROFIT,
  bidSharePct: BID_SHARE_PCT,
});

// --- the bot -------------------------------------------------------------------

await refreshChainState();
// Never fatal: the bot is useful to watch even when it cannot bond, and the
// timer below retries every 30 seconds.
await ensureBond().catch((e) => console.warn(`[bot] bond upkeep failed: ${(e as Error).message}`));
setInterval(() => {
  refreshChainState()
    .then(ensureBond)
    .catch((e) => console.warn(`[bot] refresh failed: ${(e as Error).message}`));
}, 30_000);

/**
 * A won bid means a backrun goes out, and a backrun that loses its race still
 * pays gas. Nothing about losing is visible to the strategy — the quote looked
 * fine, the edge was simply taken first — so a bad run has no natural end. The
 * arb bot has had this cap since it was written; the bidding bot did not, and
 * the difference only matters once there is money in the wallet.
 */
const DAILY_GAS_CAP = parseEther(process.env.ORDO_SEARCHER_DAILY_GAS_CAP_ETH ?? "0.01");
const gasLedger: { at: number; wei: bigint }[] = [];
let breakerLogged = false;

function gasBurnedToday(): bigint {
  const cutoff = Date.now() - 86_400_000;
  while (gasLedger.length && gasLedger[0].at < cutoff) gasLedger.shift();
  return gasLedger.reduce((n, e) => n + e.wei, 0n);
}

/** Charged when a bid is submitted: it is the moment we commit to paying for a transaction. */
function chargeGas(wei: bigint): void {
  gasLedger.push({ at: Date.now(), wei });
}

function breakerTripped(): boolean {
  const burned = gasBurnedToday();
  if (burned < DAILY_GAS_CAP) {
    breakerLogged = false;
    return false;
  }
  if (!breakerLogged) {
    breakerLogged = true;
    console.error(
      `[bot] BREAKER — ${formatEther(burned)} ETH of gas committed in the last 24h, cap ${formatEther(DAILY_GAS_CAP)}. ` +
        `Bidding stops until that rolls off or the process is restarted.`,
    );
  }
  return true;
}

const searcher = new OrdoSearcher({
  auctionWsUrl: AUCTION_WS,
  privateKey: KEY,
  settlementAddress: SETTLEMENT,
  onOpportunity: async (opp) => {
    if (breakerTripped()) return null;
    // Everything here happens inside the bid window, so the only network calls
    // are quotes; the pool's pair and its fee tiers were looked up the first
    // time this pool appeared and are remembered.
    if (opp.hint.poolsTouched.length === 0) return null;
    const started = Date.now();

    const cycles = (await Promise.all(opp.hint.poolsTouched.map((p) => cycleCache.cyclesFor(p)))).flat();
    const decision = await evaluate(rpcCall, cycles, strategy(), { deadlineMs: EVAL_BUDGET_MS });

    if (!decision.best || decision.bidWei === 0n) {
      // The honest outcome most of the time, and the one the old fixed bid hid:
      // there was nothing here worth paying for.
      console.log(`[bot] no bid on ${opp.id.slice(0, 8)} — ${decision.reason}`);
      return null;
    }

    const backrunRawTx = await signedBackrun(decision.best, decision.bidWei);
    chargeGas(gasCostWei());
    console.log(
      `[bot] bidding ${formatEther(decision.bidWei)} ETH on ${opp.id.slice(0, 8)} — ${decision.reason} (${Date.now() - started}ms)`,
    );
    return { maxBidWei: decision.bidWei, backrunRawTx };
  },
});

console.log(`OrdoFi searcher bot | ${account.address}`);
console.log(`OrdoFi searcher bot | auction=${AUCTION_WS} settlement=${SETTLEMENT || "(none — bids will be unsettleable)"}`);
console.log(`OrdoFi searcher bot | max bid ${formatEther(MAX_BID)} ETH · bond target ${formatEther(BOND_TARGET)} ETH`);
console.log(
  `OrdoFi searcher bot | trade budget ${formatEther(TRADE_BUDGET)} ETH · bids ${BID_SHARE_PCT}% of the net edge · stops after ${formatEther(DAILY_GAS_CAP)} ETH of gas in 24h`,
);
searcher.connect();
