import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeFunctionData, decodeFunctionResult, formatEther, parseEther, type Hex } from "viem";
import { normalizePrivateKey, rpcFetch } from "@ordofi/core";
import { OrdoSearcher } from "@ordofi/sdk";

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

const AUCTION_WS = process.env.ORDO_AUCTION_WS ?? "ws://localhost:8548/searcher";
const SETTLEMENT = (process.env.ORDO_SETTLEMENT_ADDRESS ?? "") as Hex;
const KEY = normalizePrivateKey(process.env.SEARCHER_KEY, "SEARCHER_KEY") ?? generatePrivateKey();
const MAX_BID = parseEther(process.env.ORDO_MAX_BID_ETH ?? "0.001");
const BOND_TARGET = process.env.ORDO_BOND_TARGET_ETH
  ? parseEther(process.env.ORDO_BOND_TARGET_ETH)
  : MAX_BID * 2n;

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

async function refreshChainState(): Promise<void> {
  const [nonceHex, gasPriceHex, gasHex] = await Promise.all([
    rpcFetch("eth_getTransactionCount", [account.address, "pending"]),
    rpcFetch("eth_gasPrice", []),
    rpcFetch("eth_estimateGas", [{ from: account.address, to: account.address, value: "0x0" }]),
  ]);
  nonce = parseInt(nonceHex as string, 16);
  maxFeePerGas = BigInt(gasPriceHex as string) * 2n;
  // Headroom over the estimate: the L1 data component drifts with calldata prices.
  gasLimit = (BigInt(gasHex as string) * 3n) / 2n;
}

async function signedSelfTransfer(): Promise<Hex> {
  return account.signTransaction({
    chainId: 4663,
    to: account.address,
    value: 0n,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    nonce: nonce++,
    type: "eip1559",
  });
}

// --- bond upkeep --------------------------------------------------------------

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

// --- the bot -------------------------------------------------------------------

await refreshChainState();
await ensureBond();
setInterval(() => {
  refreshChainState()
    .then(ensureBond)
    .catch((e) => console.warn(`[bot] refresh failed: ${(e as Error).message}`));
}, 30_000);

const searcher = new OrdoSearcher({
  auctionWsUrl: AUCTION_WS,
  privateKey: KEY,
  settlementAddress: SETTLEMENT,
  onOpportunity: async (opp) => {
    // Naive strategy: a small constant bid on anything that moves a pool.
    // Everything here must be local — the auction closes in ~200ms.
    if (opp.hint.poolsTouched.length === 0) return null;
    const maxBidWei = MAX_BID / 2n;
    const backrunRawTx = await signedSelfTransfer();
    console.log(`[bot] bidding ${formatEther(maxBidWei)} ETH on ${opp.id.slice(0, 8)} (${opp.hint.poolsTouched.length} pools)`);
    return { maxBidWei, backrunRawTx };
  },
});

console.log(`OrdoFi searcher bot | ${account.address}`);
console.log(`OrdoFi searcher bot | auction=${AUCTION_WS} settlement=${SETTLEMENT || "(none — bids will be unsettleable)"}`);
console.log(`OrdoFi searcher bot | max bid ${formatEther(MAX_BID)} ETH · bond target ${formatEther(BOND_TARGET)} ETH`);
searcher.connect();
