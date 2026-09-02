#!/usr/bin/env node
/**
 * Prove the trade loop on mainnet with real money, small amounts, every step
 * with a hash — and, this time, with the wallet's own balance as the judge.
 *
 * Walks the exact path that lost a user 0.376 ETH on 2026-09-02: ETH in for
 * USDG, then USDG back out as native ETH (approval included), each leg quoted
 * by the production API for this wallet, sent through the protected RPC, and
 * then checked against eth_getBalance / balanceOf rather than the receipt's
 * status. A leg where the wallet does not end up with at least the quoted
 * minimum fails the run, whatever the chain says about "success".
 *
 *   ORDO_PROVE_KEY=0x… node --import tsx scripts/prove-trade.mjs
 *   ORDO_WEB=https://app.ordofi.network   (default)  ORDO_PROVE_ETH=0.0005 (default)
 *   ORDO_PROVE_RPC=https://rpc.ordofi.network (default; where the signed txs go)
 */
import { privateKeyToAccount } from "viem/accounts";
import { formatEther, formatUnits, parseEther } from "viem";
import { normalizePrivateKey, rpcFetch, rpcOnce, sendRawTransaction } from "@ordofi/core";

const KEY = normalizePrivateKey(process.env.ORDO_PROVE_KEY ?? process.env.ORDO_ARB_KEY, "ORDO_PROVE_KEY");
const WEB = process.env.ORDO_WEB ?? "https://app.ordofi.network";
const SEND_RPC = process.env.ORDO_PROVE_RPC ?? "https://rpc.ordofi.network";
const ETH_IN = parseEther(process.env.ORDO_PROVE_ETH ?? "0.0005");
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const SAFE_UNWRAP = "49616997"; // unwrapWETH9(uint256)
const BUGGY_UNWRAP = "49404b7c"; // unwrapWETH9(uint256,address)

const payer = privateKeyToAccount(KEY);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const ok = (s) => console.log(`    ok   ${s}`);
const fail = (s) => { console.error(`    FAIL ${s}`); process.exit(1); };
const api = async (p) => { const r = await fetch(`${WEB}${p}`); const d = await r.json(); if (d.error) throw new Error(d.error); return d; };
const ethBal = async () => BigInt(await rpcFetch("eth_getBalance", [payer.address, "latest"]));
const usdgBal = async () => BigInt(await rpcFetch("eth_call", [{ to: USDG, data: "0x70a08231" + payer.address.slice(2).padStart(64, "0") }, "latest"]));

async function send(tx) {
  const [nonceHex, gasPriceHex] = await Promise.all([rpcFetch("eth_getTransactionCount", [payer.address, "pending"]), rpcFetch("eth_gasPrice", [])]);
  const value = BigInt(tx.value ?? 0);
  const gas = (BigInt(await rpcFetch("eth_estimateGas", [{ from: payer.address, to: tx.to, data: tx.data, value: "0x" + value.toString(16) }])) * 3n) / 2n;
  const raw = await payer.signTransaction({ chainId: 4663, to: tx.to, data: tx.data, value, gas, maxFeePerGas: BigInt(gasPriceHex) * 2n, maxPriorityFeePerGas: 0n, nonce: parseInt(nonceHex, 16), type: "eip1559" });
  let hash;
  try {
    hash = await rpcOnce(SEND_RPC, "eth_sendRawTransaction", [raw]);
  } catch (e) {
    if (/nobody controls|would revert/.test(e.message)) throw e; // the protected RPC said no: that is the answer
    console.log(`    note ${SEND_RPC} unavailable (${e.message}); sending to the sequencer directly`);
    hash = await sendRawTransaction(raw);
  }
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const rec = await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (rec) return { hash, status: rec.status, gasWei: BigInt(rec.gasUsed) * BigInt(rec.effectiveGasPrice ?? gasPriceHex) };
  }
  throw new Error(`unconfirmed ${hash}`);
}

/** The quote must be for this wallet, proven, and encode nothing we have banned. */
function checkQuote(q, label) {
  if ((q.for ?? "").toLowerCase() !== payer.address.toLowerCase()) fail(`${label}: quote.for is ${q.for}, not this wallet`);
  if (q.guard?.ok !== true) fail(`${label}: guard not ok — ${q.guard?.reason}`);
  if (!q.tx?.data) fail(`${label}: no tx in a quote with guard.ok`);
  if (q.tx.to.toLowerCase() !== ROUTER) fail(`${label}: tx.to is ${q.tx.to}, not SwapRouter02`);
  if (q.tx.data.toLowerCase().includes(BUGGY_UNWRAP)) fail(`${label}: calldata contains unwrapWETH9(uint256,address)`);
  const rec = q.guard.received?.[0];
  ok(`${label}: proven for ${q.for} · simulated receive ${rec?.amount} (min ${q.minOut}) · leaks ${q.guard.leaks.length} · via ${q.guard.via}`);
}

console.log(`OrdoFi trade proof | ${payer.address} | api ${WEB} | sends via ${SEND_RPC}`);
const eth0 = await ethBal(), usdg0 = await usdgBal();
console.log(`    wallet: ${formatEther(eth0)} ETH, ${formatUnits(usdg0, 6)} USDG`);
if (eth0 < ETH_IN * 3n) fail(`fund ${payer.address} with at least ${formatEther(ETH_IN * 3n)} ETH`);

step(1, `Quote ${formatEther(ETH_IN)} ETH -> USDG for this wallet`);
const q1 = await api(`/api/trade/quote?tokenIn=eth&tokenOut=${USDG}&amountIn=${ETH_IN}&slippageBps=100&from=${payer.address}`);
checkQuote(q1, "leg 1");
if (q1.tx.data.toLowerCase().includes(SAFE_UNWRAP)) fail("leg 1: a token-out swap must not unwrap");

step(2, "Send it and judge by the balance, not the receipt");
const r1 = await send(q1.tx);
if (r1.status !== "0x1") fail(`leg 1 reverted ${r1.hash}`);
const eth1 = await ethBal(), usdg1 = await usdgBal();
const gotUsdg = usdg1 - usdg0;
if (gotUsdg < BigInt(q1.minOut)) fail(`leg 1 ${r1.hash}: wallet received ${gotUsdg} USDG, below the promised ${q1.minOut}`);
if (eth0 - eth1 > ETH_IN + r1.gasWei) fail(`leg 1 ${r1.hash}: wallet paid ${formatEther(eth0 - eth1)} ETH, more than ${formatEther(ETH_IN)} + gas`);
ok(`${r1.hash} · received ${formatUnits(gotUsdg, 6)} USDG (min ${formatUnits(BigInt(q1.minOut), 6)}) · paid ${formatEther(eth0 - eth1)} ETH incl. gas`);

step(3, `Quote ${formatUnits(gotUsdg, 6)} USDG -> native ETH for this wallet (the path that burned funds)`);
let q2 = await api(`/api/trade/quote?tokenIn=${USDG}&tokenOut=eth&amountIn=${gotUsdg}&slippageBps=100&from=${payer.address}`);
checkQuote(q2, "leg 2");
if (!q2.tx.data.toLowerCase().includes(SAFE_UNWRAP)) fail("leg 2: native-out swap must end with unwrapWETH9(uint256)");
if (q2.approval) {
  step(4, "Approve exactly the amount for SwapRouter02");
  const ra = await send({ to: q2.approval.token, data: q2.approval.data });
  if (ra.status !== "0x1") fail(`approval reverted ${ra.hash}`);
  ok(`approved — ${ra.hash}`);
  q2 = await api(`/api/trade/quote?tokenIn=${USDG}&tokenOut=eth&amountIn=${gotUsdg}&slippageBps=100&from=${payer.address}`);
  checkQuote(q2, "leg 2 (re-quoted)");
  if (q2.approval) fail("approval still requested after approving");
}

step(5, "Send it and judge by the balance, not the receipt");
const r2 = await send(q2.tx);
if (r2.status !== "0x1") fail(`leg 2 reverted ${r2.hash}`);
const eth2 = await ethBal(), usdg2 = await usdgBal();
const gotEth = eth2 - eth1 + r2.gasWei; // what the router paid us, gas added back
if (gotEth < BigInt(q2.minOut)) fail(`leg 2 ${r2.hash}: wallet received ${formatEther(gotEth)} ETH, below the promised ${formatEther(BigInt(q2.minOut))} — CHECK 0x0000000000000000000000000000000000000001`);
if (usdg1 - usdg2 !== gotUsdg) fail(`leg 2 ${r2.hash}: wallet paid ${usdg1 - usdg2} USDG, not ${gotUsdg}`);
ok(`${r2.hash} · received ${formatEther(gotEth)} ETH (min ${formatEther(BigInt(q2.minOut))}) · paid ${formatUnits(gotUsdg, 6)} USDG`);

step(6, "Round trip");
console.log(`    ETH  ${formatEther(eth0)} -> ${formatEther(eth2)} (${formatEther(eth2 - eth0)} incl. gas ${formatEther(r1.gasWei + r2.gasWei)})`);
console.log(`    USDG ${formatUnits(usdg0, 6)} -> ${formatUnits(usdg2, 6)}`);
console.log(`\nBoth legs delivered to ${payer.address}. Hashes: ${r1.hash} ${r2.hash}`);
