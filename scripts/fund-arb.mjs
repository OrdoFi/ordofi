// One-shot: move seed capital from the house searcher wallet to the arb
// wallet. Both keys are read from the environment and never printed. Amount in
// ETH via ORDO_FUND_ETH (default 0.0025). Refuses if it would leave the source
// wallet unable to cover the transfer plus gas.
import { privateKeyToAccount } from "viem/accounts";
import { formatEther, parseEther } from "viem";
import { normalizePrivateKey, rpcFetch } from "@ordofi/core";

const fromKey = normalizePrivateKey(process.env.ORDO_HOUSE_SEARCHER_KEY, "ORDO_HOUSE_SEARCHER_KEY");
const arbKey = normalizePrivateKey(process.env.ORDO_ARB_KEY, "ORDO_ARB_KEY");
if (!fromKey || !arbKey) {
  console.error("need both ORDO_HOUSE_SEARCHER_KEY and ORDO_ARB_KEY set");
  process.exit(1);
}
const from = privateKeyToAccount(fromKey);
const to = privateKeyToAccount(arbKey).address;
const amount = parseEther(process.env.ORDO_FUND_ETH ?? "0.0025");

const balance = BigInt(await rpcFetch("eth_getBalance", [from.address, "latest"]));
const gasPrice = BigInt(await rpcFetch("eth_gasPrice", [])) * 2n;
const gas = 21000n;
const fee = gas * gasPrice;

console.log(`from ${from.address} balance ${formatEther(balance)} ETH`);
console.log(`to   ${to}`);
console.log(`send ${formatEther(amount)} ETH (+ ~${formatEther(fee)} gas)`);

if (balance < amount + fee) {
  console.error(`insufficient: need ${formatEther(amount + fee)} ETH, have ${formatEther(balance)}`);
  process.exit(1);
}

const nonce = parseInt(await rpcFetch("eth_getTransactionCount", [from.address, "pending"]), 16);
const raw = await from.signTransaction({
  chainId: 4663, to, value: amount, gas,
  maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n, nonce, type: "eip1559",
});
const hash = await rpcFetch("eth_sendRawTransaction", [raw]);
console.log(`sent ${hash}`);

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const rec = await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null);
  if (!rec) continue;
  console.log(rec.status === "0x1" ? `confirmed — arb wallet funded` : `FAILED ${hash}`);
  const nb = BigInt(await rpcFetch("eth_getBalance", [to, "latest"]));
  console.log(`arb wallet balance now ${formatEther(nb)} ETH`);
  process.exit(rec.status === "0x1" ? 0 : 1);
}
console.error("not confirmed in 30s");
process.exit(1);
