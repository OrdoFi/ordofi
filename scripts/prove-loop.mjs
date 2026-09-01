// Proves the revenue loop on a real chain: a bonded searcher signs an EIP-712
// bid, wins the auction, and settle() lands on-chain with the rebate credited.
//
// The sibling apps/auction/test-settlement.mjs does this against a local Anvil
// with baked-in test keys, nonce 0 and 0.01 ETH bids. None of that survives
// mainnet, so this reads real nonces, real fees, and bids an amount small
// enough that a failed run costs less than a coffee.
//
//   ORDO_SEARCHER_KEY=0x... ORDO_USER_KEY=0x... node scripts/prove-loop.mjs
//
// Everything else has a sane default. ORDO_BID_ETH sets the bid size.
import { WebSocket } from "ws";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// MetaMask exports keys without the 0x prefix; viem requires it.
const normalizeKey = (v, name) => {
  const t = v?.trim();
  if (!t) return undefined;
  const k = t.startsWith("0x") ? t : "0x" + t;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die(`${name} is not a 32-byte hex key`);
  return k;
};

const RPC = process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const AUCTION = process.env.ORDO_AUCTION_URL ?? "http://auction:8548";
const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS;
const APP = process.env.ORDO_APP_ADDRESS ?? "0x0000000000000000000000000000000000000000";
const BID = parseEther(process.env.ORDO_BID_ETH ?? "0.0002");
const CHAIN_ID = 4663;

const die = (m) => {
  console.error(`\nFAILED: ${m}`);
  process.exit(1);
};

if (!SETTLEMENT) die("set ORDO_SETTLEMENT_ADDRESS");
if (!process.env.ORDO_SEARCHER_KEY) die("set ORDO_SEARCHER_KEY");
if (!process.env.ORDO_USER_KEY) die("set ORDO_USER_KEY");

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const searcher = privateKeyToAccount(normalizeKey(process.env.ORDO_SEARCHER_KEY, "ORDO_SEARCHER_KEY"));
const user = privateKeyToAccount(normalizeKey(process.env.ORDO_USER_KEY, "ORDO_USER_KEY"));
const pub = createPublicClient({ chain, transport: http(RPC) });

const VIEW = (name) => [
  {
    type: "function",
    name,
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
const bondOf = (a) =>
  pub.readContract({ address: SETTLEMENT, abi: VIEW("bond"), functionName: "bond", args: [a] });
const claimableOf = (a) =>
  pub.readContract({ address: SETTLEMENT, abi: VIEW("claimable"), functionName: "claimable", args: [a] });

const BID_TYPES = {
  Bid: [
    { name: "searcher", type: "address" },
    { name: "opportunityId", type: "bytes32" },
    { name: "maxAmountWei", type: "uint256" },
  ],
};
const toBytes32 = (id) => "0x" + id.replace(/-/g, "").padEnd(64, "0");

// --- preflight ----------------------------------------------------------------

console.log("--------------------------------------------------------");
console.log("OrdoFi revenue loop proof");
console.log(`  chain      : ${CHAIN_ID} via ${RPC}`);
console.log(`  settlement : ${SETTLEMENT}`);
console.log(`  auction    : ${AUCTION}`);
console.log(`  searcher   : ${searcher.address}`);
console.log(`  user       : ${user.address}`);
console.log(`  app        : ${APP}`);
console.log(`  bid        : ${formatEther(BID)} ETH`);
console.log("--------------------------------------------------------");

const [searcherBal, userBal, bondBefore] = await Promise.all([
  pub.getBalance({ address: searcher.address }),
  pub.getBalance({ address: user.address }),
  bondOf(searcher.address),
]);
console.log(`searcher balance : ${formatEther(searcherBal)} ETH`);
console.log(`user balance     : ${formatEther(userBal)} ETH`);
console.log(`searcher bond    : ${formatEther(bondBefore)} ETH`);

if (userBal === 0n) die("the user account has no ETH for gas");

// --- bond ---------------------------------------------------------------------

if (bondBefore < BID) {
  const topUp = BID - bondBefore;
  if (searcherBal < topUp) {
    die(`searcher needs at least ${formatEther(topUp)} ETH to bond, holds ${formatEther(searcherBal)}`);
  }
  console.log(`\nbonding ${formatEther(topUp)} ETH...`);
  const wallet = createWalletClient({ account: searcher, chain, transport: http(RPC) });
  const hash = await wallet.sendTransaction({ to: SETTLEMENT, value: topUp });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  bonded, tx ${hash}`);
  console.log(`  bond now ${formatEther(await bondOf(searcher.address))} ETH`);
}

// --- prefetch and pre-sign ------------------------------------------------------
//
// The auction's bid window is 200ms, and a real searcher spends none of it on
// RPC round trips. Everything remote happens here, before the WebSocket opens:
// fees, nonces, and a gas estimate (hardcoding 21000 is wrong on an Arbitrum
// chain — intrinsic gas includes the L1 data-posting component, and the
// sequencer rejects the transaction outright with "intrinsic gas too low").
// Both transactions are independent of the opportunity, so they are signed
// before the auction ever sees us; the opportunity handler only signs the
// EIP-712 bid, which is local and takes microseconds.

const [fees, searcherNonce, userNonce, selfTransferGas] = await Promise.all([
  pub.estimateFeesPerGas(),
  pub.getTransactionCount({ address: searcher.address }),
  pub.getTransactionCount({ address: user.address }),
  pub.estimateGas({ account: user.address, to: user.address, value: 0n }),
]);
const gasLimit = (selfTransferGas * 3n) / 2n; // headroom for L1-component drift
const txDefaults = {
  chainId: CHAIN_ID,
  value: 0n,
  gas: gasLimit,
  maxFeePerGas: fees.maxFeePerGas * 2n,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  type: "eip1559",
};
const rawUserTx = await user.signTransaction({ ...txDefaults, to: user.address, nonce: userNonce });
const rawBackrunTx = await searcher.signTransaction({ ...txDefaults, to: searcher.address, nonce: searcherNonce });
console.log(`\nprefetched: gas limit ${gasLimit}, fees ${fees.maxFeePerGas} wei, nonces ${searcherNonce}/${userNonce}`);

// --- the loop -----------------------------------------------------------------

const ws = new WebSocket(`${AUCTION.replace(/^http/, "ws")}/searcher`);
let finished = false;

const timer = setTimeout(() => {
  if (!finished) die("timed out waiting for the auction");
}, 60_000);

ws.on("error", (e) => die(`websocket: ${e.message}`));

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "welcome") {
    console.log("\n[searcher] connected to the auction feed");

    console.log("[user] submitting a transaction through the auction...");
    const res = await fetch(`${AUCTION}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawTx: rawUserTx, originLabel: "loop-proof", rebateAddress: APP }),
    });
    const out = await res.json();

    console.log(`[auction] bids            : ${out.result?.bidCount ?? 0}`);
    console.log(`[auction] winner          : ${out.result?.winner ?? "(none)"}`);
    console.log(`[auction] clearing price  : ${out.result?.clearingPriceWei ?? 0} wei`);
    console.log(`[auction] user tx         : ${out.result?.userTxHash ?? "(not dispatched)"}`);
    console.log(`[auction] settlement tx   : ${out.settlementTxHash ?? "(none)"}`);
    if (out.userError) console.log(`[auction] user error      : ${out.userError}`);

    finished = true;
    clearTimeout(timer);

    if (!out.settlementTxHash) {
      die(
        out.result?.winner
          ? "an auction was won but nothing settled — is ORDO_AUCTIONEER_KEY set on the auction?"
          : "no winning bid, so there was nothing to settle",
      );
    }

    await pub.waitForTransactionReceipt({ hash: out.settlementTxHash });

    const [userClaim, appClaim, bondAfter] = await Promise.all([
      claimableOf(user.address),
      claimableOf(APP),
      bondOf(searcher.address),
    ]);

    console.log("\n--- ON-CHAIN RESULT ---");
    console.log(`searcher bond    : ${formatEther(bondAfter)} ETH (was ${formatEther(bondBefore < BID ? BID : bondBefore)})`);
    console.log(`user claimable   : ${formatEther(userClaim)} ETH`);
    console.log(`app claimable    : ${formatEther(appClaim)} ETH`);
    console.log("\nRESULT: revenue loop CLOSED — value settled on-chain.");
    process.exit(0);
  }

  if (msg.type === "opportunity") {
    const wallet = createWalletClient({ account: searcher, chain, transport: http(RPC) });
    const bidSig = await wallet.signTypedData({
      account: searcher,
      domain: {
        name: "OrdoSettlement",
        version: "1",
        chainId: BigInt(CHAIN_ID),
        verifyingContract: SETTLEMENT,
      },
      types: BID_TYPES,
      primaryType: "Bid",
      message: {
        searcher: searcher.address,
        opportunityId: toBytes32(msg.opportunity.id),
        maxAmountWei: BID,
      },
    });

    // The backrun was pre-signed at startup — a self-transfer is enough to
    // prove the plumbing, and nothing here may wait on the network.
    ws.send(
      JSON.stringify({
        type: "bid",
        opportunityId: msg.opportunity.id,
        searcher: searcher.address,
        bidWei: BID.toString(),
        backrunRawTx: rawBackrunTx,
        bidSig,
      }),
    );
    console.log(`[searcher] signed an EIP-712 bid for ${formatEther(BID)} ETH`);
  }

  if (msg.type === "bid_ack") {
    console.log(`[searcher] bid ${msg.accepted ? "accepted" : "REJECTED"} ${msg.reason ?? ""}`);
  }
});
