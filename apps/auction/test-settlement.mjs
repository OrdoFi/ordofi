// End-to-end proof that the revenue loop closes:
// searcher bonds -> signs an EIP-712 bid -> wins -> settlement lands on-chain.
import { WebSocket } from "ws";
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ORDO_RPC_URL ?? "http://localhost:8545";
const AUCTION = "http://localhost:8548";
const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS;
const CHAIN_ID = 4663;

const chain = { id: CHAIN_ID, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const searcher = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1
const user = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");     // anvil #3
const APP = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

const pub = createPublicClient({ chain, transport: http(RPC) });
const claimable = (a) => pub.readContract({ address: SETTLEMENT, abi: [{ type: "function", name: "claimable", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }], functionName: "claimable", args: [a] });

const BID_TYPES = { Bid: [{ name: "searcher", type: "address" }, { name: "opportunityId", type: "bytes32" }, { name: "maxAmountWei", type: "uint256" }] };
const toBytes32 = (id) => "0x" + id.replace(/-/g, "").padEnd(64, "0");

const ws = new WebSocket("ws://localhost:8548/searcher");
let nonce = 0;

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "welcome") {
    console.log("[searcher] connected, bonded:", formatEther(await pub.readContract({ address: SETTLEMENT, abi: [{ type: "function", name: "bond", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }], functionName: "bond", args: [searcher.address] })), "ETH");
    const rawTx = await user.signTransaction({ chainId: CHAIN_ID, to: user.address, value: 0n, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, nonce: 0, type: "eip1559" });
    const res = await fetch(`${AUCTION}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx, originLabel: "e2e", rebateAddress: APP }) });
    const out = await res.json();
    console.log("[auction] winner:", out.result?.winner);
    console.log("[auction] clearing price:", out.result?.clearingPriceWei, "wei");
    console.log("[auction] settlement tx:", out.settlementTxHash ?? "(none)");

    if (out.settlementTxHash) {
      await pub.waitForTransactionReceipt({ hash: out.settlementTxHash });
      console.log("\n--- ON-CHAIN RESULT ---");
      console.log("user claimable :", formatEther(await claimable(user.address)), "ETH");
      console.log("app  claimable :", formatEther(await claimable(APP)), "ETH");
      console.log("\nRESULT: revenue loop CLOSED — value settled on-chain.");
      process.exit(0);
    }
    console.log("\nRESULT: no on-chain settlement (check ORDO_AUCTIONEER_KEY).");
    process.exit(1);
  }

  if (msg.type === "opportunity") {
    const maxBidWei = parseEther("0.01");
    const wallet = createWalletClient({ account: searcher, chain, transport: http(RPC) });
    const bidSig = await wallet.signTypedData({
      account: searcher,
      domain: { name: "OrdoSettlement", version: "1", chainId: BigInt(CHAIN_ID), verifyingContract: SETTLEMENT },
      types: BID_TYPES, primaryType: "Bid",
      message: { searcher: searcher.address, opportunityId: toBytes32(msg.opportunity.id), maxAmountWei: maxBidWei },
    });
    const backrunRawTx = await searcher.signTransaction({ chainId: CHAIN_ID, to: searcher.address, value: 0n, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, nonce: nonce++, type: "eip1559" });
    ws.send(JSON.stringify({ type: "bid", opportunityId: msg.opportunity.id, searcher: searcher.address, bidWei: maxBidWei.toString(), backrunRawTx, bidSig }));
    console.log("[searcher] signed EIP-712 bid: 0.01 ETH");
  }

  if (msg.type === "bid_ack") console.log("[searcher] bid ack:", msg.accepted, msg.reason ?? "");
});

ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 25000);
