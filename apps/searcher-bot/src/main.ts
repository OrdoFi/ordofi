import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseEther, type Hex } from "viem";
import { OrdoSearcher } from "@ordofi/sdk";

/**
 * Reference OrdoFi searcher bot.
 *
 * A minimal, adaptable strategy: for every opportunity, bid a fixed fraction of
 * a configured cap and submit a (placeholder) backrun. Real searchers replace
 * `decide()` with pool-state simulation to compute the true backrun profit and
 * bid up to that. This exists so a searcher can be live against OrdoFi in
 * minutes, and as the canonical example of the EIP-712 bid flow.
 *
 * Env:
 *   ORDO_AUCTION_WS       wss://auction.ordofi.xyz/searcher (default ws://localhost:8548/searcher)
 *   ORDO_SETTLEMENT_ADDRESS  deployed OrdoSettlement (for EIP-712 domain)
 *   SEARCHER_KEY          searcher private key (default: ephemeral, for testing)
 *   ORDO_MAX_BID_ETH      max bid per opportunity (default 0.001)
 */

const AUCTION_WS = process.env.ORDO_AUCTION_WS ?? "ws://localhost:8548/searcher";
const SETTLEMENT = (process.env.ORDO_SETTLEMENT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex;
const KEY = (process.env.SEARCHER_KEY as Hex) ?? generatePrivateKey();
const MAX_BID = parseEther(process.env.ORDO_MAX_BID_ETH ?? "0.001");

const account = privateKeyToAccount(KEY);

async function backrunTxFor(nonce: number): Promise<Hex> {
  // Placeholder backrun: a self-transfer. Replace with your arb route calldata.
  return account.signTransaction({
    chainId: 4663,
    to: account.address,
    value: 0n,
    gas: 21000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    nonce,
    type: "eip1559",
  });
}

let nonce = 0;

const searcher = new OrdoSearcher({
  auctionWsUrl: AUCTION_WS,
  privateKey: KEY,
  settlementAddress: SETTLEMENT,
  onOpportunity: async (opp) => {
    // Naive strategy: always bid a small fraction on opportunities that touch a
    // pool. A real bot simulates the backrun and bids up to expected profit.
    if (opp.hint.poolsTouched.length === 0) return null;
    const maxBidWei = MAX_BID / 2n;
    const backrunRawTx = await backrunTxFor(nonce++);
    console.log(`[bot] bidding ${maxBidWei} wei on ${opp.id.slice(0, 8)} (${opp.hint.poolsTouched.length} pools)`);
    return { maxBidWei, backrunRawTx };
  },
});

console.log(`OrdoFi searcher bot | ${account.address}`);
console.log(`OrdoFi searcher bot | auction=${AUCTION_WS} settlement=${SETTLEMENT}`);
console.log(`OrdoFi searcher bot | max bid ${MAX_BID} wei/opp`);
searcher.connect();
