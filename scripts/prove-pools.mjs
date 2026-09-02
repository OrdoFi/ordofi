#!/usr/bin/env node
/**
 * Prove the Pools loop on mainnet: plan a ladder through the web API, mint it
 * through OrdoLadderManager, read it back through the positions API, collect,
 * close. Real money, small amounts, every step with a hash.
 *
 *   ORDO_ARB_KEY=0x… ORDO_WEB=http://web:3000 node scripts/prove-pools.mjs
 */
import { privateKeyToAccount } from "viem/accounts";
import { formatEther, parseEther } from "viem";
import { normalizePrivateKey, rpcFetch, sendRawTransaction } from "@ordofi/core";

const KEY = normalizePrivateKey(process.env.ORDO_ARB_KEY, "ORDO_ARB_KEY");
const WEB = process.env.ORDO_WEB ?? "http://web:3000";
const POOL = "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca"; // WETH/USDG 0.01%
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const payer = privateKeyToAccount(KEY);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const ok = (s) => console.log(`    ok   ${s}`);
const api = async (p) => { const r = await fetch(`${WEB}${p}`); const d = await r.json(); if (d.error) throw new Error(d.error); return d; };

async function send(tx) {
  const [nonceHex, gasPriceHex] = await Promise.all([rpcFetch("eth_getTransactionCount", [payer.address, "pending"]), rpcFetch("eth_gasPrice", [])]);
  const gas = (BigInt(await rpcFetch("eth_estimateGas", [{ from: payer.address, to: tx.to, data: tx.data, value: "0x" + (tx.value ?? 0n).toString(16) }])) * 3n) / 2n;
  const raw = await payer.signTransaction({ chainId: 4663, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas, maxFeePerGas: BigInt(gasPriceHex) * 2n, maxPriorityFeePerGas: 0n, nonce: parseInt(nonceHex, 16), type: "eip1559" });
  const hash = await sendRawTransaction(raw);
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); const rec = await rpcFetch("eth_getTransactionReceipt", [hash]).catch(() => null); if (rec) { if (rec.status !== "0x1") throw new Error(`reverted ${hash}`); return { hash, gasUsed: BigInt(rec.gasUsed) }; } }
  throw new Error(`unconfirmed ${hash}`);
}

console.log(`OrdoFi pools proof | ${payer.address}`);
step(1, "Plan a bid-ask ladder entirely above the price — ETH only, 0.003 ETH");
const st = await api(`/api/pools/state?pool=${POOL}&base=${WETH}`);
ok(`ETH/USDG at ${st.price.toFixed(2)} USDG, tick ${st.tick}`);
const plan = await api(`/api/pools/plan?pool=${POOL}&base=${WETH}&minPrice=${(st.price * 1.003).toFixed(4)}&maxPrice=${(st.price * 1.03).toFixed(4)}&shape=bidask&bins=5&baseAmount=${parseEther("0.003")}&quoteAmount=0`);
if (!plan.tx) throw new Error("planner produced nothing");
ok(`${plan.rungs.length} rungs from ${plan.minPrice.toFixed(2)} to ${plan.maxPrice.toFixed(2)} · needs ${formatEther(BigInt(plan.baseTotal))} ETH, ${plan.quoteTotal} USDG · limited by ${plan.limitedBy}`);
if (plan.tx.approve) throw new Error("did not expect an approval for an ETH-only ladder");

step(2, "Mint it through OrdoLadderManager");
const balBefore = BigInt(await rpcFetch("eth_getBalance", [payer.address, "latest"]));
const m = await send({ to: plan.tx.to, data: plan.tx.data, value: BigInt(plan.tx.value) });
ok(`minted — ${m.hash}`);

step(3, "Read it back through the positions API");
// The upstream's "latest" can trail the sequencer by a second or two.
let l = null;
for (let i = 0; i < 12 && !l; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const pos = await api(`/api/pools/positions?owner=${payer.address}`);
  const open = pos.ladders.filter((x) => !x.closed).sort((a, b) => Number(b.id) - Number(a.id));
  if (open.length && open[0].rungs.length === plan.rungs.length && open[0].rungs[0].tickLower === plan.rungs[0].tickLower) l = open[0];
}
if (!l) throw new Error("positions API never showed the new ladder");
ok(`ladder #${l.id} · ${l.rungs.length} rungs · value ${l.valueUsd.toFixed(2)} USD · deposited ${l.depositedUsd.toFixed(2)} USD · in range: ${l.rungs.filter((r) => r.inRange).length}`);
if (l.rungs.length !== plan.rungs.length) throw new Error("rung count mismatch");
for (let i = 0; i < l.rungs.length; i++) if (l.rungs[i].tickLower !== plan.rungs[i].tickLower || l.rungs[i].tickUpper !== plan.rungs[i].tickUpper) throw new Error(`rung ${i} ticks differ from the plan`);
ok("every rung's ticks match the plan exactly");

step(4, "Collect (nothing accrued yet — proves the path and the fee logic)");
const c = await api(`/api/pools/collect?id=${l.id}`);
const cr = await send({ to: c.to, data: c.data });
ok(`collected — ${cr.hash}`);

step(5, "Close: principal back as native ETH, positions burned");
const cl = await api(`/api/pools/close?id=${l.id}`);
const clr = await send({ to: cl.to, data: cl.data });
const after = await api(`/api/pools/positions?owner=${payer.address}`);
const closed = after.ladders.find((x) => x.id === l.id);
if (!closed?.closed) throw new Error("ladder not marked closed");
const balAfter = BigInt(await rpcFetch("eth_getBalance", [payer.address, "latest"]));
const lost = balBefore - balAfter;
ok(`closed — ${clr.hash}`);
ok(`net cost of the round trip: ${formatEther(lost)} ETH (gas only; principal returned)`);
if (lost > parseEther("0.002")) throw new Error("lost more than gas — principal did not come back");
console.log(`\nPASS — planned, minted, indexed, collected and closed a ${plan.rungs.length}-rung ladder on mainnet.`);
console.log(`  mint    https://robinhoodchain.blockscout.com/tx/${m.hash}`);
console.log(`  close   https://robinhoodchain.blockscout.com/tx/${clr.hash}`);
