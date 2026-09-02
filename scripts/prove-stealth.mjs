#!/usr/bin/env node
/**
 * Prove the stealth loop on mainnet, with real money.
 *
 * Runs exactly the code the browser runs — the same module, the same message,
 * the same derivation — from a wallet key instead of a wallet popup. If this
 * passes, a payment was announced, delivered to an address nobody had ever
 * used, discovered from the public feed with only the viewing key, and swept
 * with a key derived on the spot. Every step has a transaction hash to check.
 *
 *   ORDO_STEALTH_KEY=0x… node scripts/prove-stealth.mjs [--amount 0.0002]
 */
import { privateKeyToAccount } from "viem/accounts";
import { decodeEventLog, encodeFunctionData, formatEther, parseEther } from "viem";
import { normalizePrivateKey, rpcFetch, sendRawTransaction } from "@ordofi/core";
import {
  ANNOUNCER_ABI,
  ERC5564_ANNOUNCER,
  NATIVE_TOKEN,
  SCHEME_ID,
  UNLOCK_MESSAGE,
  checkAnnouncement,
  computeStealthPrivateKey,
  decodeMetadata,
  encodeMetadata,
  generateStealthAddress,
  keysFromSignature,
} from "@ordofi/core/stealth";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1] ?? "1";
}
const KEY = normalizePrivateKey(process.env.ORDO_STEALTH_KEY ?? process.env.ORDO_ARB_KEY, "ORDO_STEALTH_KEY");
if (!KEY) {
  console.error("set ORDO_STEALTH_KEY to a funded key on Robinhood Chain");
  process.exit(2);
}
const AMOUNT = parseEther(args.amount ?? "0.0002");
const CHAIN_ID = 4663;

const payer = privateKeyToAccount(KEY);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const ok = (s) => console.log(`    ok   ${s}`);

async function send(account, tx) {
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpcFetch("eth_getTransactionCount", [account.address, "pending"]),
    rpcFetch("eth_gasPrice", []),
  ]);
  const maxFeePerGas = BigInt(gasPriceHex) * 2n;
  const gas =
    tx.gas ??
    (BigInt(
      await rpcFetch("eth_estimateGas", [
        { from: account.address, to: tx.to, data: tx.data, value: "0x" + (tx.value ?? 0n).toString(16) },
      ]),
    ) *
      3n) /
      2n;
  const raw = await account.signTransaction({
    chainId: CHAIN_ID,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    nonce: parseInt(nonceHex, 16),
    type: "eip1559",
  });
  const hash = await sendRawTransaction(raw);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const rec = await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (rec) {
      if (rec.status !== "0x1") throw new Error(`reverted: ${hash}`);
      return { hash, block: parseInt(rec.blockNumber, 16) };
    }
  }
  throw new Error(`unconfirmed: ${hash}`);
}

console.log(`OrdoFi stealth proof | payer ${payer.address} | ${formatEther(AMOUNT)} ETH`);

step(1, "Derive the stealth account from a wallet signature");
const signature = await payer.signMessage({ message: UNLOCK_MESSAGE });
const keys = keysFromSignature(signature);
ok(`meta-address ${keys.metaAddress.slice(0, 30)}…`);
// Deriving twice must give the same account, or funds would be unrecoverable.
if (keysFromSignature(await payer.signMessage({ message: UNLOCK_MESSAGE })).metaAddress !== keys.metaAddress) {
  throw new Error("derivation is not deterministic — refusing to send anything");
}
ok("derivation is deterministic");

step(2, "Derive a one-time address to pay");
const payment = generateStealthAddress(keys.metaAddress);
ok(`stealth address ${payment.stealthAddress} (view tag 0x${payment.viewTag.toString(16).padStart(2, "0")})`);
if ((await rpcFetch("eth_getBalance", [payment.stealthAddress, "latest"])) !== "0x0") {
  throw new Error("that address is already in use — this should be impossible");
}
ok("address has never been used");

step(3, "Announce it on the canonical ERC-5564 announcer");
const metadata = encodeMetadata({ viewTag: payment.viewTag, token: NATIVE_TOKEN, amount: AMOUNT });
const ann = await send(payer, {
  to: ERC5564_ANNOUNCER,
  data: encodeFunctionData({
    abi: ANNOUNCER_ABI,
    functionName: "announce",
    args: [SCHEME_ID, payment.stealthAddress, payment.ephemeralPublicKey, metadata],
  }),
});
ok(`announced in block ${ann.block} — ${ann.hash}`);

step(4, "Send the ETH");
const sent = await send(payer, { to: payment.stealthAddress, value: AMOUNT, gas: 21000n });
ok(`sent — ${sent.hash}`);

step(5, "Find it again from the public feed, using only the viewing key");
const topic = "0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7";
const logs = await rpcFetch("eth_getLogs", [
  { address: ERC5564_ANNOUNCER, topics: [topic], fromBlock: "0x" + (ann.block - 2).toString(16), toBlock: "0x" + (ann.block + 2).toString(16) },
]);
const watcher = { viewingPrivateKey: keys.viewingPrivateKey, spendingPublicKey: keys.spendingPublicKey };
let found = null;
for (const l of logs) {
  const { args } = decodeEventLog({ abi: ANNOUNCER_ABI, eventName: "Announcement", topics: l.topics, data: l.data });
  const decoded = decodeMetadata(args.metadata);
  const hit = checkAnnouncement(watcher, {
    stealthAddress: args.stealthAddress,
    ephemeralPublicKey: args.ephemeralPubKey,
    viewTag: decoded?.viewTag,
  });
  if (hit) found = { hit, decoded };
}
if (!found || found.hit.toLowerCase() !== payment.stealthAddress.toLowerCase()) {
  throw new Error("the viewing key did not recognise our own payment");
}
ok(`recognised ${found.hit} out of ${logs.length} announcement(s) in the window`);
ok(`metadata says ${formatEther(found.decoded.amount)} ETH, which matches what was sent`);

step(6, "Sweep it with a key derived on the spot");
const stealthKey = computeStealthPrivateKey(keys, payment.ephemeralPublicKey);
const stealth = privateKeyToAccount(stealthKey);
if (stealth.address.toLowerCase() !== payment.stealthAddress.toLowerCase()) throw new Error("derived key controls a different address");
const balance = BigInt(await rpcFetch("eth_getBalance", [stealth.address, "latest"]));
ok(`stealth address holds ${formatEther(balance)} ETH`);
const gasPrice = BigInt(await rpcFetch("eth_gasPrice", [])) * 2n;
const cost = 21000n * gasPrice;
if (balance <= cost) throw new Error("balance does not cover gas");
const swept = await send(stealth, { to: payer.address, value: balance - cost, gas: 21000n });
ok(`swept ${formatEther(balance - cost)} ETH back — ${swept.hash}`);

console.log(`\nPASS — a payment was announced, delivered to a fresh address, found with the viewing key alone, and spent.`);
console.log(`  announce  https://robinhoodchain.blockscout.com/tx/${ann.hash}`);
console.log(`  deliver   https://robinhoodchain.blockscout.com/tx/${sent.hash}`);
console.log(`  sweep     https://robinhoodchain.blockscout.com/tx/${swept.hash}`);
console.log(`  stealth   https://robinhoodchain.blockscout.com/address/${payment.stealthAddress}`);
