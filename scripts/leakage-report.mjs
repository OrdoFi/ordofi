/**
 * Per-app MEV leakage report — the outbound pitch, generated from measured
 * data rather than asserted.
 *
 * The argument it makes is narrow on purpose: "here is how much backrun
 * activity your pools attracted, from how many distinct bots, and here is the
 * floor on what they extracted." Every number is checkable on-chain, and the
 * priced total is stated as a floor because most arbitrage profit books out in
 * tokens this cannot value. Overstating it once would cost more credibility
 * than the extra digits are worth.
 *
 *   node scripts/leakage-report.mjs --name "v4.fun" --pools 0xabc,0xdef
 *   node scripts/leakage-report.mjs --name "Robinhood Chain" --json
 *
 * With no --pools it reports the whole chain, which is the right framing for
 * a first email to an ecosystem rather than a single app.
 */
import { getTokenInfo, toWhole } from "@ordofi/core/pricing";
import { OrdoStore } from "@ordofi/store";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const NAME = flag("name", "Robinhood Chain");
const POOLS = (flag("pools", "") || "").split(",").map((p) => p.trim()).filter(Boolean);
const AS_JSON = args.includes("--json");
const DB = flag("db", process.env.ORDO_DB ?? "data/ordo.db");
const ETH_USD = Number(process.env.ORDO_ETH_USD ?? 2250);
const REBATE_USER = Number(process.env.ORDO_REBATE_USER ?? 0.9);
const REBATE_APP = Number(process.env.ORDO_REBATE_APP ?? 0.05);

const store = new OrdoStore(DB);
const d = store.poolLeakage(POOLS);

if (d.arbs === 0) {
  console.error(`No arbitrage indexed${POOLS.length ? " for those pools" : ""} in ${DB}. Is the watcher running?`);
  process.exit(1);
}

const window = store.window();

// Each quote token is valued with its own decimals and USD anchor. Summing
// raw wei across tokens and calling it ether reads a six-decimal stablecoin
// as 1e12 times its real size — the first draft of this script did exactly
// that and reported twenty million dollars a day.
const byToken = [];
let pricedUsd = 0;
for (const row of d.profitByToken) {
  const info = await getTokenInfo(row.token);
  const amount = toWhole(row.wei, info.decimals);
  const value = info.usdPerToken === null ? null : amount * info.usdPerToken;
  if (value !== null) pricedUsd += value;
  byToken.push({ token: row.token, symbol: info.symbol, amount, usd: value, arbs: row.arbs });
}

// Same floor the homepage uses: a daily rate extrapolated from minutes is a
// number that gets the whole document dismissed by the one reader who checks.
const MIN_EXTRAPOLATION_HOURS = 1;
const perDayUsd =
  window.spanHours >= MIN_EXTRAPOLATION_HOURS ? pricedUsd / (window.spanHours / 24) : null;
const usd = (n) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        subject: NAME,
        pools: POOLS.length || "all",
        window: { blocks: [d.firstBlock, d.lastBlock], hours: Number(window.spanHours.toFixed(2)) },
        arbs: d.arbs,
        distinctSearchers: d.searchers,
        pricedArbs: d.pricedArbs,
        pricedProfitUsd: pricedUsd,
        byToken: byToken.map((b) => ({ ...b, amount: Number(b.amount.toFixed(6)) })),
        note: "priced figures are a floor; long-tail token profit is counted but not valued",
        pricedProfitUsdPerDay: perDayUsd,
        ifRouted: {
          toUsersUsd: pricedUsd * REBATE_USER,
          toAppUsd: pricedUsd * REBATE_APP,
        },
        topSearchers: d.topSearchers,
        topPools: d.topPools,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const line = "─".repeat(64);
console.log(line);
console.log(`MEV leakage — ${NAME}`);
console.log(line);
console.log(`Measured over blocks ${d.firstBlock}–${d.lastBlock} (${window.spanHours.toFixed(1)}h)`);
console.log(`Scope               : ${POOLS.length ? `${POOLS.length} pool(s)` : "entire chain"}`);
console.log("");
console.log(`Atomic arbitrages   : ${d.arbs.toLocaleString()}`);
console.log(`Distinct searchers  : ${d.searchers.toLocaleString()}   (all competing for the same flow)`);
console.log(`Priced arbitrages   : ${d.pricedArbs.toLocaleString()} of ${d.arbs.toLocaleString()}`);
console.log("");
console.log(`Extracted (floor)   : ≈ ${usd(pricedUsd)}`);
console.log(
  perDayUsd === null
    ? `  per day           : not extrapolated — needs at least ${MIN_EXTRAPOLATION_HOURS}h of samples`
    : `  per day           : ≈ ${usd(perDayUsd)}`,
);
for (const b of byToken) {
  const valued = b.usd === null ? "unpriced" : usd(b.usd);
  console.log(`    ${b.symbol.padEnd(8)} ${b.amount.toFixed(6).padStart(18)}  ${valued}  (${b.arbs.toLocaleString()} arbs)`);
}
console.log("");
console.log("  This is a FLOOR. Only profit booked in WETH or stablecoins is valued;");
console.log("  arbitrage ending in long-tail tokens is counted but not priced, and");
console.log("  bots routing through executor contracts hide more. The true figure is");
console.log("  higher and needs call-trace attribution to state honestly.");
console.log("");
console.log("If this flow routed through OrdoFi:");
console.log(`  back to users     : ≈ ${usd(pricedUsd * REBATE_USER)}  (${(REBATE_USER * 100).toFixed(0)}%)`);
console.log(`  to ${NAME.padEnd(14).slice(0, 14)}: ≈ ${usd(pricedUsd * REBATE_APP)}  (${(REBATE_APP * 100).toFixed(0)}%)`);
console.log("");
console.log("Most contested pools:");
for (const p of d.topPools) console.log(`  ${p.pool}  ${p.count.toLocaleString()} arbs`);
console.log("");
console.log("Most active searchers:");
for (const s of d.topSearchers) console.log(`  ${s.address}  ${s.count.toLocaleString()} arbs`);
console.log(line);
console.log("Measured by OrdoFi — https://app.ordofi.network/explorer");
console.log(line);
