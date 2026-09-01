/**
 * Which venues are leaking, and therefore who to talk to first.
 *
 * leakage-report.mjs answers "how much is this pool set losing" once you
 * already know which pools belong to whom. This answers the question that
 * comes before it: of everything the watcher has indexed, which DEX does the
 * contested flow actually belong to. Pools are grouped by the factory that
 * deployed them, because that is the one attribution the chain will confirm
 * without anyone's say-so.
 *
 *   node scripts/leakage-venues.mjs
 *   node scripts/leakage-venues.mjs --top 60 --json
 *
 * The output is an outreach order: venues ranked by extracted value, with the
 * pools and token pairs to quote in the first email.
 */
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { rpcFetch } from "@ordofi/core";
import { getTokenInfo, toWhole } from "@ordofi/core/pricing";
import { OrdoStore } from "@ordofi/store";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const TOP = Number(flag("top", 40));
const AS_JSON = args.includes("--json");
const DB = flag("db", process.env.ORDO_DB ?? "data/ordo.db");
const REBATE_USER = Number(process.env.ORDO_REBATE_USER ?? 0.9);
const REBATE_APP = Number(process.env.ORDO_REBATE_APP ?? 0.05);

const VIEW_ABI = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
];

/** Returns null rather than throwing: plenty of pools omit any given getter. */
async function read(address, functionName) {
  try {
    const data = await rpcFetch("eth_call", [
      { to: address, data: encodeFunctionData({ abi: VIEW_ABI, functionName }) },
      "latest",
    ]);
    if (!data || data === "0x") return null;
    return decodeFunctionResult({ abi: VIEW_ABI, functionName, data });
  } catch {
    return null;
  }
}

const store = new OrdoStore(DB);
const window = store.window();
const overall = store.poolLeakage([]);

if (overall.arbs === 0) {
  console.error(`No arbitrage indexed in ${DB}. Is the watcher running?`);
  process.exit(1);
}

const pools = store.topPools(TOP);

/**
 * Value a pool set's extracted profit in USD, per token, as leakage-report
 * does. Always ask the store about the whole set at once: an arbitrage touches
 * several pools and its profit belongs to the transaction, not to each pool
 * it passed through, so summing per-pool answers counts the same dollars once
 * per hop. Doing that produced venue totals 2.5x the chain-wide figure.
 */
async function pricedUsdFor(pools) {
  const d = store.poolLeakage(pools);
  let usd = 0;
  let unpricedTokens = 0;
  for (const row of d.profitByToken) {
    const info = await getTokenInfo(row.token);
    if (info.usdPerToken === null) {
      unpricedTokens++;
      continue;
    }
    usd += toWhole(row.wei, info.decimals) * info.usdPerToken;
  }
  return { usd, unpricedTokens, arbs: d.arbs, searchers: d.searchers };
}

const rows = [];
for (const { pool, count } of pools) {
  const [factory, token0, token1, fee] = await Promise.all([
    read(pool, "factory"),
    read(pool, "token0"),
    read(pool, "token1"),
    read(pool, "fee"),
  ]);
  const [i0, i1] = await Promise.all([
    token0 ? getTokenInfo(token0) : Promise.resolve(null),
    token1 ? getTokenInfo(token1) : Promise.resolve(null),
  ]);
  const priced = await pricedUsdFor([pool]);
  rows.push({
    pool,
    arbs: count,
    factory: factory ? String(factory).toLowerCase() : null,
    pair: i0 && i1 ? `${i0.symbol}/${i1.symbol}` : null,
    fee: fee == null ? null : Number(fee),
    usd: priced.usd,
    searchers: priced.searchers,
    unpricedTokens: priced.unpricedTokens,
  });
}

// A pool that will not name its factory is not evidence of anything; it is
// grouped separately rather than guessed at, so the venue totals stay claims
// the chain will back up.
const UNKNOWN = "unattributed";
const venues = new Map();
for (const r of rows) {
  const key = r.factory ?? UNKNOWN;
  const v = venues.get(key) ?? { factory: key, pools: [], arbs: 0, usd: 0, searchers: 0 };
  v.pools.push(r);
  v.arbs += r.arbs;
  v.usd += r.usd;
  venues.set(key, v);
}
// Venue totals come from one query over all of that venue's pools, so an
// arbitrage hopping between two of them is counted once.
for (const v of venues.values()) {
  const priced = await pricedUsdFor(v.pools.map((p) => p.pool));
  v.usd = priced.usd;
  v.arbs = priced.arbs;
  v.searchers = priced.searchers;
  v.pools.sort((a, b) => b.usd - a.usd || b.arbs - a.arbs);
}
const ranked = [...venues.values()].sort((a, b) => b.usd - a.usd || b.arbs - a.arbs);

// Distinct arbs across every sampled pool, for the same reason.
const sampled = store.poolLeakage(rows.map((r) => r.pool));
const sampledArbs = sampled.arbs;
const chainUsd = (await pricedUsdFor([])).usd;
const totalUsd = ranked.reduce((n, v) => n + v.usd, 0);

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        window: { blocks: [overall.firstBlock, overall.lastBlock], hours: Number(window.spanHours.toFixed(2)) },
        scope: { topPools: TOP, sampledArbs, indexedArbs: overall.arbs },
        chainPricedUsd: chainUsd,
        venuesPricedUsd: totalUsd,
        venues: ranked,
        note: "priced figures are a floor; profit booked in tokens without a USD anchor is counted but not valued",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const usd = (n) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const line = "─".repeat(78);

console.log(line);
console.log("MEV leakage by venue — Robinhood Chain");
console.log(line);
console.log(`Window : blocks ${overall.firstBlock}–${overall.lastBlock} (${window.spanHours.toFixed(1)}h)`);
console.log(
  `Scope  : top ${TOP} pools by arb count — ${sampledArbs.toLocaleString()} of ` +
    `${overall.arbs.toLocaleString()} indexed arbs (${((sampledArbs / overall.arbs) * 100).toFixed(0)}%)`,
);
console.log(`Chain  : ${usd(chainUsd)} extracted across every indexed pool (floor)`);
console.log("");
console.log("VENUE (factory)                              POOLS    ARBS   EXTRACTED   SHARE");
for (const v of ranked) {
  // Share of the chain-wide total, not of the venue sum: an arbitrage that
  // crosses two venues is counted by both, so the shares can exceed 100%.
  const share = chainUsd > 0 ? ((v.usd / chainUsd) * 100).toFixed(0) + "%" : "—";
  const name = v.factory === UNKNOWN ? "unattributed (no factory())" : v.factory;
  console.log(
    `${name.padEnd(44)} ${String(v.pools.length).padStart(5)} ${v.arbs.toLocaleString().padStart(7)} ` +
      `${usd(v.usd).padStart(11)} ${share.padStart(6)}`,
  );
}
console.log("");

for (const v of ranked) {
  const name = v.factory === UNKNOWN ? "Unattributed pools (factory() not exposed)" : `Factory ${v.factory}`;
  console.log(line);
  console.log(`${name}`);
  console.log(
    `  ${v.pools.length} contested pool(s) · ${v.arbs.toLocaleString()} arbs · ${usd(v.usd)} extracted (floor)`,
  );
  console.log("");
  for (const p of v.pools) {
    const pair = p.pair ?? "unknown pair";
    const fee = p.fee == null ? "" : ` ${(p.fee / 10000).toFixed(2)}%`;
    console.log(
      `    ${p.pool}  ${pair.padEnd(18)}${fee.padEnd(7)} ` +
        `${p.arbs.toLocaleString().padStart(6)} arbs  ${usd(p.usd).padStart(11)}`,
    );
  }
  console.log("");
  console.log(`  If this venue's flow routed through OrdoFi:`);
  console.log(`    back to its users : ≈ ${usd(v.usd * REBATE_USER)}`);
  console.log(`    to the venue      : ≈ ${usd(v.usd * REBATE_APP)}`);
  console.log("");
}

console.log(line);
console.log("Every figure is a floor. Only profit booked in tokens with a USD anchor is");
console.log("valued; long-tail token profit is counted but not priced, and bots routing");
console.log("through executor contracts hide more. Attribution is by on-chain factory(),");
console.log("so a venue's identity is checkable rather than asserted.");
console.log("");
console.log("Per-pool rows overlap: an arbitrage touching three pools appears under all");
console.log("three. Venue and chain totals are de-duplicated, so they will be smaller");
console.log("than the pool rows above them add up to, and venue shares can exceed 100%");
console.log("where a route crosses venues.");
console.log(line);
console.log("Measured by OrdoFi — https://app.ordofi.network/explorer");
console.log(line);
