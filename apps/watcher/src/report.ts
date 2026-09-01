import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ArbObservation, type SwapObservation } from "@ordofi/core";
import { getTokenInfo, toWhole } from "@ordofi/core/pricing";

const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");
const JSON_OUT = process.env.ORDO_REPORT_JSON ?? join(DATA_DIR, "report.json");

function readNdjson<T>(file: string): T[] {
  try {
    return readFileSync(join(DATA_DIR, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  const arbs = readNdjson<ArbObservation>("arbs.ndjson");
  const swaps = readNdjson<SwapObservation>("swaps.ndjson");

  if (arbs.length === 0 && swaps.length === 0) {
    console.log("No data yet. Run the watcher first: npm run watcher");
    return;
  }

  const blocks = [...arbs, ...swaps].map((x) => x.block);
  const minBlock = Math.min(...blocks);
  const maxBlock = Math.max(...blocks);
  const times = [...arbs, ...swaps].map((x) => x.timestamp).filter(Boolean);
  const spanSec = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const spanHours = spanSec / 3600;

  const uniqueSearchers = new Set(arbs.map((a) => a.sender)).size;
  const uniquePools = new Set(swaps.map((s) => s.pool)).size;

  // USD-denominated extractable value from quote-token (WETH/stable) profits.
  let usdTotal = 0;
  let pricedArbs = 0;
  let unpricedArbs = 0;
  let gasUsdSpent = 0;
  const usdBySymbol = new Map<string, number>();

  for (const a of arbs) {
    if (a.profitIsQuote && a.profitToken && a.profitWei) {
      const info = await getTokenInfo(a.profitToken);
      if (info.usdPerToken !== null) {
        const usd = toWhole(BigInt(a.profitWei), info.decimals) * info.usdPerToken;
        usdTotal += usd;
        usdBySymbol.set(info.symbol, (usdBySymbol.get(info.symbol) ?? 0) + usd);
        pricedArbs++;
      }
    } else {
      unpricedArbs++;
    }
    // Gas is paid in ETH; value it in USD via WETH anchor.
    if (a.gasPaidWei) {
      const ethInfo = await getTokenInfo("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
      if (ethInfo.usdPerToken !== null) {
        gasUsdSpent += toWhole(BigInt(a.gasPaidWei), 18) * ethInfo.usdPerToken;
      }
    }
  }

  const poolLeak = new Map<string, number>();
  for (const a of arbs) for (const p of a.poolsTouched) poolLeak.set(p, (poolLeak.get(p) ?? 0) + 1);
  const searcherCount = new Map<string, number>();
  for (const a of arbs) searcherCount.set(a.sender, (searcherCount.get(a.sender) ?? 0) + 1);

  const perDay = (n: number) => (spanHours > 0 ? (n / spanHours) * 24 : 0);
  const usd = (n: number) =>
    "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  console.log("========================================");
  console.log("  OrdoFi — Robinhood Chain MEV Report");
  console.log("========================================");
  console.log(`Blocks analyzed     : ${minBlock} → ${maxBlock} (${maxBlock - minBlock + 1})`);
  console.log(`Time span           : ${spanHours.toFixed(2)} h`);
  console.log(`Swaps observed      : ${swaps.length.toLocaleString()}`);
  console.log(`Unique pools        : ${uniquePools}`);
  console.log(`Atomic arbs         : ${arbs.length.toLocaleString()}`);
  console.log(`  priced (quote P&L): ${pricedArbs}`);
  console.log(`  unpriced (tokens) : ${unpricedArbs}`);
  console.log(`Unique searchers    : ${uniqueSearchers}`);
  if (spanHours >= 1) {
    console.log("");
    console.log(`Arb activity / day  : ${perDay(arbs.length).toLocaleString(undefined, { maximumFractionDigits: 0 })} atomic arbs (extrapolated)`);
    console.log(`Swap activity / day : ${perDay(swaps.length).toLocaleString(undefined, { maximumFractionDigits: 0 })} swaps (extrapolated)`);
  }
  console.log("");
  console.log(`Extractable value (quote lower bound): ${usd(usdTotal)}`);
  console.log(`  note: Transfer-log attribution only captures profit booked directly`);
  console.log(`  in WETH/stables. Bots route through executor contracts, so the true`);
  console.log(`  figure is higher and requires call-trace analysis (Phase 1b, needs`);
  console.log(`  a dedicated node). Arb COUNT and COMPETITION above are exact.`);

  console.log("\n-- Extractable value by quote token --");
  for (const [sym, v] of [...usdBySymbol.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sym.padEnd(8)} ${usd(v)}`);
  }

  console.log("\n-- Most-leaked pools (arb frequency) --");
  for (const [pool, n] of [...poolLeak.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${pool}  x${n}`);
  }

  console.log("\n-- Top searchers (arb count) --");
  for (const [s, n] of [...searcherCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${s}  x${n}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { minBlock, maxBlock, spanHours },
    totals: {
      swaps: swaps.length,
      uniquePools,
      arbs: arbs.length,
      pricedArbs,
      unpricedArbs,
      uniqueSearchers,
      extractableUsd: usdTotal,
      gasUsd: gasUsdSpent,
      netSearcherProfitUsd: usdTotal - gasUsdSpent,
    },
    // Withheld below an hour of samples: the multiplier turns a short burst
    // into a figure that discredits every honest number next to it.
    perDay:
      spanHours >= 1
        ? { extractableUsd: perDay(usdTotal), arbs: perDay(arbs.length) }
        : { extractableUsd: null, arbs: null },
    byQuoteToken: Object.fromEntries(usdBySymbol),
    topPools: [...poolLeak.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    topSearchers: [...searcherCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nMachine-readable report written to ${JSON_OUT}`);
}

main().catch((e) => {
  console.error("report failed:", e.message);
  process.exit(1);
});
