// End-to-end auction test: connect a searcher over WS, submit a user tx,
// verify the searcher receives the opportunity, bids, and the auction resolves.
import { WebSocket } from "ws";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const AUCTION = "http://localhost:8548";
const WS_URL = "ws://localhost:8548/searcher";

const userAcct = privateKeyToAccount(generatePrivateKey());
const searcherAcct = privateKeyToAccount(generatePrivateKey());

function signDummy(acct, nonce) {
  return acct.signTransaction({
    chainId: 4663,
    to: "0x0000000000000000000000000000000000000001",
    value: 0n,
    gas: 21000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    nonce,
    type: "eip1559",
  });
}

const ws = new WebSocket(WS_URL);
let gotOpportunity = false;
let gotBidAck = false;

ws.on("open", () => console.log("[searcher] connected"));
ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "welcome") {
    console.log(`[searcher] welcome, auctionWindowMs=${msg.auctionWindowMs}`);
    // Kick off a user submission now that a searcher is listening.
    const rawTx = await signDummy(userAcct, 0);
    const res = await fetch(`${AUCTION}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawTx, originLabel: "e2e-test", rebateAddress: "0xa11ce00000000000000000000000000000000001" }),
    });
    const out = await res.json();
    console.log("[user] submit result:", JSON.stringify(out.result));
    console.log("[user] rebate entry:", JSON.stringify(out.rebate));
    setTimeout(() => {
      console.log(`\nRESULT: opportunity=${gotOpportunity} bidAck=${gotBidAck} winner=${out.result?.winner ? "yes" : "none"}`);
      ws.close();
      process.exit(gotOpportunity && gotBidAck ? 0 : 1);
    }, 500);
  }
  if (msg.type === "opportunity") {
    gotOpportunity = true;
    console.log(`[searcher] opportunity ${msg.opportunity.id.slice(0, 8)} selector=${msg.opportunity.hint.selector}`);
    const backrun = await signDummy(searcherAcct, 0);
    ws.send(JSON.stringify({
      type: "bid",
      opportunityId: msg.opportunity.id,
      searcher: searcherAcct.address,
      bidWei: "5000000000000000",
      backrunRawTx: backrun,
    }));
    console.log("[searcher] bid submitted: 0.005 ETH");
  }
  if (msg.type === "bid_ack") {
    gotBidAck = true;
    console.log(`[searcher] bid ack: accepted=${msg.accepted}${msg.reason ? " reason=" + msg.reason : ""}`);
  }
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
