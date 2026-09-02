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
 * Uniswap V4 needs one extra step. It is a singleton: every V4 pool lives
 * inside the PoolManager contract, so the pool address alone collapses the
 * whole venue into one row. For that venue the report goes back to the
 * arbitrage transactions themselves, reads the V4 Swap logs out of their
 * receipts, and attributes flow per poolId — resolving each poolId to its
 * token pair through the PoolManager's own Initialize events.
 *
 *   node scripts/leakage-venues.mjs
 *   node scripts/leakage-venues.mjs --top 60 --json
 *
 * The output is an outreach order: venues ranked by extracted value, with the
 * pools and token pairs to quote in the first email.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, toEventSelector } from "viem";
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

/**
 * The Uniswap V4 singleton. All V4 pools on Robinhood Chain live inside this
 * one contract; the address is published in Uniswap's deployment docs for
 * chain 4663 and its Swap event topic is checkable against v4-core.
 */
const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

/**
 * Names for factories whose identity is confirmable: either published by the
 * protocol itself (Uniswap's deployment docs, Ramses' docs) or verified
 * source on the chain explorer. Anything not in this map is shown as a bare
 * address rather than guessed at.
 */
const VENUE_NAMES = new Map([
  [V4_POOL_MANAGER, "Uniswap V4"],
  ["0x1f7d7550b1b028f7571e69a784071f0205fd2efa", "Uniswap V3"],
  ["0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f", "Uniswap V2"],
  ["0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", "PancakeSwap V3"],
  ["0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8", "Ramses (CL)"],
  ["0xdcd5f77697914e27f56fd263ef82923c8524abac", "Ramses (DLMM)"],
  ["0x16494a80e08bcb9285d87b67149d7b01774d82f8", "Sheriff (Algebra)"],
  // Verified source: CLFactory, Velodrome Slipstream lineage. The deployment
  // is up (UP33), Robinhood Chain's native ve(3,3) DEX.
  ["0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3", "up / UP33 (Slipstream CL)"],
]);

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const venueLabel = (factory) => {
  const name = VENUE_NAMES.get(factory);
  return name ? `${name} ${short(factory)}` : factory;
};

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
const isV4PoolId = (k) => /^0x[0-9a-f]{64}$/i.test(k);
for (const { pool, count } of pools) {
  // The V4 singleton is the venue, not a pool deployed by one: probing it for
  // token0()/factory() reverts by design. Rows the watcher wrote before it
  // keyed V4 swaps by PoolId carry the singleton's address and get their
  // per-pool story from the poolId breakdown below; newer rows are PoolIds
  // and the watcher's Initialize table names their pair directly.
  if (pool.toLowerCase() === V4_POOL_MANAGER || isV4PoolId(pool)) {
    const priced = await pricedUsdFor([pool]);
    const key = isV4PoolId(pool) ? store.v4Pool(pool) : null;
    rows.push({
      pool,
      arbs: count,
      factory: V4_POOL_MANAGER,
      pair: key ? `${await v4Symbol(key.currency0)}/${await v4Symbol(key.currency1)}` : isV4PoolId(pool) ? `V4 pool ${short(pool)}` : "all V4 pools (singleton)",
      fee: key ? key.fee : null,
      usd: priced.usd,
      searchers: priced.searchers,
      unpricedTokens: priced.unpricedTokens,
    });
    continue;
  }
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

// ---------------------------------------------------------------------------
// Uniswap V4: per-pool attribution inside the singleton
// ---------------------------------------------------------------------------

const V4_SWAP_TOPIC = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const V4_INITIALIZE_ABI = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: true, name: "currency0", type: "address" },
      { indexed: true, name: "currency1", type: "address" },
      { indexed: false, name: "fee", type: "uint24" },
      { indexed: false, name: "tickSpacing", type: "int24" },
      { indexed: false, name: "hooks", type: "address" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
];
const V4_INITIALIZE_TOPIC = toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const NATIVE = "0x0000000000000000000000000000000000000000";
const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * poolId -> PoolKey, built once from the PoolManager's Initialize events and
 * cached beside the database. Every V4 pool announces its currencies, fee and
 * hook exactly once, at creation, so the scan is append-only: later runs only
 * cover blocks the cache has not seen.
 */
async function v4PoolKeys(headBlock) {
  const cachePath = path.join(path.dirname(DB), "v4-pools.json");
  // ORDO_V4_SCAN_FROM skips history before the given block. Pools created
  // earlier will show as unresolved; useful when a full scan is too slow for
  // the RPC at hand.
  const scanFloor = Number(process.env.ORDO_V4_SCAN_FROM ?? 0);
  let cache = { scannedTo: scanFloor - 1, pools: {} };
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    /* first run */
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let from = cache.scannedTo + 1;
  let span = 3_000_000;
  let backoffMs = 0;
  let stuck = 0;
  while (from <= headBlock) {
    const to = Math.min(from + span - 1, headBlock);
    try {
      const logs = await rpcFetch("eth_getLogs", [
        {
          address: V4_POOL_MANAGER,
          topics: [V4_INITIALIZE_TOPIC],
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        },
      ]);
      for (const log of logs) {
        try {
          const { args: a } = decodeEventLog({ abi: V4_INITIALIZE_ABI, data: log.data, topics: log.topics });
          cache.pools[a.id.toLowerCase()] = {
            currency0: a.currency0.toLowerCase(),
            currency1: a.currency1.toLowerCase(),
            fee: Number(a.fee),
            hooks: a.hooks.toLowerCase(),
          };
        } catch {
          /* not ours to decode */
        }
      }
      cache.scannedTo = to;
      from = to + 1;
      backoffMs = 0;
      stuck = 0;
      // Wide historical getLogs back to back is exactly what trips the
      // official endpoint's rate limiter; a short breath between chunks
      // avoids spending far longer in backoff.
      await sleep(300);
    } catch (e) {
      const msg = String(e?.message ?? e);
      // Too many results is the one failure a smaller window actually fixes.
      if (/exceeds limit|response size|more than|query returned/i.test(msg) && span > 20_000) {
        span = Math.floor(span / 2);
        continue;
      }
      // Everything else — rate limits, every upstream refusing at once — is
      // about when we ask, not what we asked: same chunk, after a pause.
      if (++stuck <= 12) {
        backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : 2_000, 20_000);
        await sleep(backoffMs);
        continue;
      }
      console.error(`v4 Initialize scan stalled at block ${from}: ${msg}`);
      break;
    }
  }
  try {
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    /* cache is an optimization, not a requirement */
  }
  return cache.pools;
}

/** Receipts for the V4 arbs, a few at a time; failures count as unresolved. */
async function v4SwapPoolIds(txHashes, concurrency = 12) {
  const byTx = new Map();
  const queue = [...txHashes];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const tx = queue.pop();
        try {
          const r = await rpcFetch("eth_getTransactionReceipt", [tx]);
          const ids = new Set();
          for (const log of r?.logs ?? []) {
            if ((log.address ?? "").toLowerCase() === V4_POOL_MANAGER && log.topics?.[0] === V4_SWAP_TOPIC) {
              ids.add(log.topics[1].toLowerCase());
            }
          }
          byTx.set(tx, [...ids]);
        } catch {
          /* unresolved */
        }
      }
    }),
  );
  return byTx;
}

async function v4Symbol(currency) {
  if (currency === NATIVE) return "ETH";
  return (await getTokenInfo(currency)).symbol;
}

async function v4Breakdown() {
  const arbs = store.arbsTouchingPool(V4_POOL_MANAGER);
  if (arbs.length === 0) return null;

  const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
  const [keys, byTx] = await Promise.all([v4PoolKeys(head), v4SwapPoolIds(arbs.map((a) => a.txHash))]);

  const perPool = new Map();
  let resolved = 0;
  for (const a of arbs) {
    const ids = byTx.get(a.txHash);
    if (!ids || ids.length === 0) continue;
    resolved++;
    for (const id of ids) {
      const p = perPool.get(id) ?? { poolId: id, arbs: 0, profit: new Map() };
      p.arbs++;
      if (a.profitIsQuote && a.profitToken && a.profitWei) {
        const t = a.profitToken.toLowerCase();
        p.profit.set(t, (p.profit.get(t) ?? 0n) + BigInt(a.profitWei));
      }
      perPool.set(id, p);
    }
  }

  const out = [];
  for (const p of perPool.values()) {
    let usd = 0;
    for (const [token, wei] of p.profit) {
      const info = await getTokenInfo(token);
      if (info.usdPerToken !== null) usd += toWhole(wei, info.decimals) * info.usdPerToken;
    }
    const key = keys[p.poolId];
    out.push({
      poolId: p.poolId,
      arbs: p.arbs,
      usd,
      pair: key ? `${await v4Symbol(key.currency0)}/${await v4Symbol(key.currency1)}` : null,
      fee: key ? key.fee : null,
      hooks: key && key.hooks !== NATIVE ? key.hooks : null,
    });
  }
  out.sort((a, b) => b.usd - a.usd || b.arbs - a.arbs);
  return { totalArbs: arbs.length, resolved, pools: out };
}

const v4 = venues.has(V4_POOL_MANAGER) ? await v4Breakdown() : null;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        window: { blocks: [overall.firstBlock, overall.lastBlock], hours: Number(window.spanHours.toFixed(2)) },
        scope: { topPools: TOP, sampledArbs, indexedArbs: overall.arbs },
        chainPricedUsd: chainUsd,
        venuesPricedUsd: totalUsd,
        venues: ranked.map((v) => ({ ...v, name: VENUE_NAMES.get(v.factory) ?? null })),
        uniswapV4: v4 && {
          totalArbs: v4.totalArbs,
          receiptsResolved: v4.resolved,
          pools: v4.pools,
        },
        note: "priced figures are a floor; profit booked in tokens without a USD anchor is counted but not valued",
      },
      (_, x) => (typeof x === "bigint" ? x.toString() : x),
      2,
    ),
  );
  process.exit(0);
}

const usd = (n) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const line = "─".repeat(78);
const feeLabel = (fee) =>
  fee == null ? "" : fee & DYNAMIC_FEE_FLAG ? " dyn" : ` ${(fee / 10000).toFixed(2)}%`;

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
console.log("VENUE                                        POOLS    ARBS   EXTRACTED   SHARE");
for (const v of ranked) {
  // Share of the chain-wide total, not of the venue sum: an arbitrage that
  // crosses two venues is counted by both, so the shares can exceed 100%.
  const share = chainUsd > 0 ? ((v.usd / chainUsd) * 100).toFixed(0) + "%" : "—";
  const name = v.factory === UNKNOWN ? "unattributed (no factory())" : venueLabel(v.factory);
  const poolCount =
    v.factory === V4_POOL_MANAGER && v4 ? v4.pools.length : v.pools.length;
  console.log(
    `${name.padEnd(44)} ${String(poolCount).padStart(5)} ${v.arbs.toLocaleString().padStart(7)} ` +
      `${usd(v.usd).padStart(11)} ${share.padStart(6)}`,
  );
}
console.log("");

for (const v of ranked) {
  console.log(line);
  if (v.factory === V4_POOL_MANAGER) {
    console.log(`Uniswap V4 — PoolManager singleton ${V4_POOL_MANAGER}`);
    if (v4) {
      console.log(
        `  ${v4.totalArbs.toLocaleString()} arbs touched the singleton · receipts resolved for ` +
          `${v4.resolved.toLocaleString()} · ${usd(v.usd)} extracted (floor)`,
      );
      console.log("");
      for (const p of v4.pools.slice(0, 14)) {
        const pair = p.pair ?? "unresolved pool";
        const hook = p.hooks ? `  hook ${short(p.hooks)}` : "";
        console.log(
          `    ${short(p.poolId).padEnd(13)} ${pair.padEnd(16)}${feeLabel(p.fee).padEnd(7)} ` +
            `${p.arbs.toLocaleString().padStart(6)} arbs  ${usd(p.usd).padStart(11)}${hook}`,
        );
      }
      if (v4.pools.length > 14) {
        console.log(`    … and ${v4.pools.length - 14} more V4 pools`);
      }
    } else {
      console.log(`  ${v.arbs.toLocaleString()} arbs · ${usd(v.usd)} extracted (floor)`);
    }
  } else {
    const name =
      v.factory === UNKNOWN ? "Unattributed pools (factory() not exposed)" : `${venueLabel(v.factory)} — factory ${v.factory}`;
    console.log(`${name}`);
    console.log(
      `  ${v.pools.length} contested pool(s) · ${v.arbs.toLocaleString()} arbs · ${usd(v.usd)} extracted (floor)`,
    );
    console.log("");
    for (const p of v.pools) {
      const pair = p.pair ?? "unknown pair";
      console.log(
        `    ${p.pool}  ${pair.padEnd(18)}${feeLabel(p.fee).padEnd(7)} ` +
          `${p.arbs.toLocaleString().padStart(6)} arbs  ${usd(p.usd).padStart(11)}`,
      );
    }
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
console.log("through executor contracts hide more. Attribution is by on-chain factory()");
console.log("(or, for Uniswap V4, by Swap poolIds in the arb receipts), so a venue's");
console.log("identity is checkable rather than asserted. Named venues are confirmed by");
console.log("the protocol's own deployment docs or verified source on the explorer.");
console.log("");
console.log("Per-pool rows overlap: an arbitrage touching three pools appears under all");
console.log("three. Venue and chain totals are de-duplicated, so they will be smaller");
console.log("than the pool rows above them add up to, and venue shares can exceed 100%");
console.log("where a route crosses venues.");
console.log(line);
console.log("Measured by OrdoFi — https://app.ordofi.network/explorer");
console.log(line);
