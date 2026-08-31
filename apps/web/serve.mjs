import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createPublicClient, http, parseAbiItem, formatEther } from "viem";

const ROOT = join(import.meta.dirname, "public");
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../data");
const PORT = Number(process.env.ORDO_WEB_PORT ?? 3000);
const RPC = process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SETTLEMENT = process.env.ORDO_SETTLEMENT_ADDRESS ?? "";

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function recentArbs(n) {
  const f = join(DATA_DIR, "arbs.ndjson");
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-n)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function auctionStats() {
  const url = process.env.ORDO_AUCTION_URL ?? "http://localhost:8548";
  try {
    const r = await fetch(`${url}/stats`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch {
    return null;
  }
}

const SETTLED_EVENT = parseAbiItem(
  "event Settled(bytes32 indexed opportunityId, address indexed searcher, uint256 amount, uint256 userAmt, uint256 appAmt, uint256 protocolAmt, address user, address app)",
);
const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed searcher, uint256 amount, uint256 newBond)",
);
const CLAIMED_EVENT = parseAbiItem("event Claimed(address indexed beneficiary, uint256 amount)");

async function onchainStats(address) {
  if (!address) return { deployed: false, note: "ORDO_SETTLEMENT_ADDRESS not set" };
  const client = createPublicClient({ transport: http(RPC) });
  const head = await client.getBlockNumber();
  // Scan a recent window; a production indexer would persist a cursor.
  const fromBlock = head > 500000n ? head - 500000n : 0n;

  const [settled, deposited, claimed] = await Promise.all([
    client.getLogs({ address, event: SETTLED_EVENT, fromBlock, toBlock: head }),
    client.getLogs({ address, event: DEPOSITED_EVENT, fromBlock, toBlock: head }),
    client.getLogs({ address, event: CLAIMED_EVENT, fromBlock, toBlock: head }),
  ]);

  let totalSettled = 0n, totalUser = 0n, totalApp = 0n, totalProtocol = 0n;
  for (const l of settled) {
    totalSettled += l.args.amount;
    totalUser += l.args.userAmt;
    totalApp += l.args.appAmt;
    totalProtocol += l.args.protocolAmt;
  }
  let totalBonded = 0n;
  for (const l of deposited) totalBonded += l.args.amount;
  let totalClaimed = 0n;
  for (const l of claimed) totalClaimed += l.args.amount;

  const recent = settled.slice(-15).reverse().map((l) => ({
    opportunityId: l.args.opportunityId,
    searcher: l.args.searcher,
    amountEth: formatEther(l.args.amount),
    userEth: formatEther(l.args.userAmt),
    app: l.args.app,
    txHash: l.transactionHash,
    block: Number(l.blockNumber),
  }));

  return {
    deployed: true,
    address,
    rpc: RPC,
    scannedFromBlock: Number(fromBlock),
    headBlock: Number(head),
    totals: {
      settlements: settled.length,
      totalSettledEth: formatEther(totalSettled),
      rebatesToUsersEth: formatEther(totalUser),
      rebatesToAppsEth: formatEther(totalApp),
      protocolFeesEth: formatEther(totalProtocol),
      totalBondedEth: formatEther(totalBonded),
      totalClaimedEth: formatEther(totalClaimed),
    },
    recent,
  };
}

createServer(async (req, res) => {
  let path = (req.url ?? "/").split("?")[0];
  const url = new URL(req.url ?? "/", "http://x");

  // Public API: CORS-open so external sites (e.g. the Framer marketing site)
  // can embed live OrdoFi numbers directly.
  if (path.startsWith("/api/")) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("cache-control", "public, max-age=15");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
  }

  // Compact, embed-friendly stats for the marketing site.
  if (path === "/api/stats") {
    const f = join(DATA_DIR, "report.json");
    const rep = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
    let onchain = { deployed: false };
    try {
      onchain = await onchainStats(SETTLEMENT);
    } catch {
      /* ignore */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        chain: { name: "Robinhood Chain", chainId: 4663 },
        arbs: rep?.totals?.arbs ?? 0,
        searchers: rep?.totals?.uniqueSearchers ?? 0,
        pools: rep?.totals?.uniquePools ?? 0,
        swaps: rep?.totals?.swaps ?? 0,
        arbsPerDay: Math.round(rep?.perDay?.arbs ?? 0),
        settlement: onchain.deployed
          ? {
              deployed: true,
              address: onchain.address,
              settlements: onchain.totals.settlements,
              totalSettledEth: onchain.totals.totalSettledEth,
              rebatesToUsersEth: onchain.totals.rebatesToUsersEth,
              totalBondedEth: onchain.totals.totalBondedEth,
            }
          : { deployed: false },
        updatedAt: new Date().toISOString(),
      }),
    );
    return;
  }

  if (path === "/api/report") {
    const f = join(DATA_DIR, "report.json");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(existsSync(f) ? readFileSync(f) : JSON.stringify({ error: "run the report first" }));
    return;
  }

  if (path === "/api/onchain") {
    res.writeHead(200, { "content-type": "application/json" });
    try {
      const addr = url.searchParams.get("address") || SETTLEMENT;
      res.end(JSON.stringify(await onchainStats(addr)));
    } catch (e) {
      res.end(JSON.stringify({ deployed: false, error: e.message }));
    }
    return;
  }

  if (path === "/api/arbs/recent") {
    const n = Math.min(200, Number(url.searchParams.get("n") ?? 40));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(recentArbs(n)));
    return;
  }

  if (path === "/api/auction") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await auctionStats()));
    return;
  }

  if (path === "/api/explorer") {
    res.writeHead(200, { "content-type": "application/json" });
    const reportFile = join(DATA_DIR, "report.json");
    const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
    let onchain = { deployed: false };
    try {
      onchain = await onchainStats(SETTLEMENT);
    } catch {
      /* ignore */
    }
    res.end(
      JSON.stringify({
        report,
        recentArbs: recentArbs(40),
        auction: await auctionStats(),
        onchain,
        generatedAt: new Date().toISOString(),
      }),
    );
    return;
  }

  if (path === "/") path = "/index.html";
  if (path === "/docs") path = "/docs.html";
  if (path === "/dashboard") path = "/dashboard.html";
  if (path === "/explorer") path = "/explorer.html";
  if (path === "/searchers") path = "/searchers.html";
  if (path === "/apps") path = "/apps.html";
  if (path === "/operators") path = "/operators.html";
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`OrdoFi web | http://localhost:${PORT}  (dashboard at /dashboard)`));
