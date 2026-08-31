# OrdoFi

**The execution layer for Robinhood Chain.**

OrdoFi is what Jito's BAM is to Solana, built for Robinhood Chain (Arbitrum
Nitro L2, chain ID 4663): private transaction submission, revert protection,
best-effort bundles, a backrun order-flow auction, and MEV revenue shared back
to the apps and users who create it. Built by OrdoFi Labs. *Ordo* — Latin:
order, sequence.

> Not affiliated with Robinhood Markets, Inc.

## Why this chain is different

Robinhood Chain has a single, Robinhood-operated sequencer and orders
transactions **first-come-first-served** with no public mempool. So classic
sandwiching is rare, and MEV is a **latency race**: searchers colocated near the
sequencer (AWS us-east-2) backrun price-moving trades on the chain's DEXs. Today
that value flows entirely to the fastest bots. OrdoFi captures it and shares it.

Measured live from mainnet, a short sample already shows **hundreds of atomic
arbitrages across hundreds of pools, contested by hundreds of distinct searcher
addresses** — the market is real and competitive. Run `npm run report` for
current numbers against your own data.

## Monorepo

| Package | Port | What it does |
| --- | --- | --- |
| `packages/core` | — | Chain config, DEX event topics, quote-token registry, on-chain pricing |
| `apps/watcher` | — | Follows the head, detects swaps + atomic arbs, writes NDJSON, and generates a USD-denominated MEV report |
| `apps/gateway` | 8547 | Smart JSON-RPC: `eth_*` passthrough, revert-protected sends, `ordo_simulate`, `ordo_sendBundle`, API keys, rate limits, `/health` + `/metrics` |
| `apps/auction` | 8548 | Backrun order-flow auction: user `/submit`, searcher WS feed, sealed-bid second-price auctioneer, rebate ledger |
| `apps/web` | 3000 | Landing page, docs, and live on-chain settlement **dashboard** (`/dashboard`) |
| `apps/searcher-bot` | — | Reference searcher bot: connects to the auction, signs EIP-712 bids, submits backruns |
| `packages/sdk` | — | `@ordofi/sdk` — searcher/app SDK (bid signing, bond management, order-flow submission) |
| `contracts` | — | `OrdoSettlement.sol` — on-chain bonded settlement for the auction (Foundry) |

### Searcher SDK

```ts
import { OrdoSearcher } from "@ordofi/sdk";

const searcher = new OrdoSearcher({
  auctionWsUrl: "wss://auction.ordofi.xyz/searcher",
  privateKey: process.env.SEARCHER_KEY,
  settlementAddress: process.env.ORDO_SETTLEMENT_ADDRESS,
  onOpportunity: async (opp) => {
    // simulate the backrun, decide a max bid; return null to skip
    return { maxBidWei: 10n ** 15n, backrunRawTx };
  },
});
searcher.connect();
```

Run the reference bot: `npm run searcher-bot`. Honest USD MEV numbers:
`npm run trace` (requires a trace-enabled node — see below).

## Quickstart

```bash
npm install
cp .env.example .env         # optional; sensible defaults built in

npm run watcher              # measure MEV → data/*.ndjson
npm run report               # USD report → data/report.json
npm run gateway              # smart RPC on :8547
npm run auction              # order-flow auction on :8548
npm run web                  # site on :3000
npm run typecheck            # all services
```

Or the whole stack in Docker:

```bash
cd deploy && docker compose up --build
```

## Gateway usage

```bash
# revert-protected submit (simulated first; rejected if it would revert)
curl -X POST localhost:8547 -H 'x-api-key: KEY' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x02f8..."]}'

# simulate without sending
curl -X POST localhost:8547 -H 'x-api-key: KEY' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ordo_simulate","params":["0x02f8..."]}'
```

## Order-flow auction usage

```bash
# an app routes a user tx through the auction to earn rebates
curl -X POST localhost:8548/submit -H 'content-type: application/json' \
  -d '{"rawTx":"0x02f8...","originLabel":"v4.fun","rebateAddress":"0xapp..."}'

# searchers connect to ws://localhost:8548/searcher, receive opportunities, bid
curl localhost:8548/stats     # throughput + accrued rebates
```

See `apps/web/public/docs.html` (served at `/docs`) for the full API.

## Settlement contract

`contracts/OrdoSettlement.sol` makes the auction economically real: searchers
bond native ETH, and each winning auction is settled on-chain, debiting the
searcher's bond and crediting claimable rebates to the user, the app, and the
protocol. It's **trust-minimized** — every settlement carries the searcher's own
EIP-712 signature over their bid, so the off-chain auctioneer can never
over-charge. Second-price aware (searcher signs a max bid, is charged the lower
clearing price), with replay protection, high-s signature-malleability rejection,
and reentrancy guards.

```bash
cd contracts
forge test              # 18 tests incl. fuzz value-conservation + security guards
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast \
  --private-key $DEPLOYER_KEY \
  --sig "run(address,address,uint16,uint16)" $AUCTIONEER $TREASURY 500 500
```

The auction service writes settlement-ready records (`data/settlements.ndjson`)
for every winning auction; set `ORDO_SETTLEMENT_ADDRESS` to submit them on-chain.

**Verified against real mainnet state:** the contract deploys and runs a full
deposit → signed-bid → second-price settle → claim lifecycle on a fork of
Robinhood Chain (`forge test --match-contract Fork --fork-url robinhood`), and
the live dashboard reads settlement events straight from the contract.

### Deploying to Robinhood Chain

Deploy costs **well under $1**. Uses a Foundry encrypted keystore — your key is
never on the command line:

```bash
cast wallet import ordo-deployer --interactive   # paste key + set password once
# fund the printed deployer address with a little ETH on Robinhood Chain
cd contracts
AUCTIONEER=0x... TREASURY=0x... ./deploy.sh
```

## Production deployment

- **Own Nitro node** (`deploy/nitro-node/`) — full node for Robinhood Chain with
  `--http.api` including `debug` (enables `debug_traceTransaction` for honest MEV
  numbers) and archive mode. Colocate in AWS us-east-2 (the sequencer's region).
- **Edge + services** (`deploy/docker-compose.prod.yml` + `deploy/Caddyfile`) —
  gateway, auction, web, and watcher behind Caddy with automatic TLS at
  `rpc.ordofi.xyz`, `auction.ordofi.xyz`, `ordofi.xyz`.

```bash
ORDO_RPC_URL=http://nitro:8547 docker compose -f deploy/docker-compose.prod.yml up -d
```

## Tests & CI

- `npm test` — unit tests for detection, auction resolution, rebate math, rate limiting.
- `cd contracts && forge test` — 19 contract tests incl. fuzz + fork + security guards.
- CI workflow provided at `deploy/github-ci.yml` — move to `.github/workflows/`
  to run typecheck, unit tests, and forge tests on every push.

## Design honesty (Phase 1 trade-offs)

- **No true bundle atomicity.** Impossible on an FCFS chain without sequencer
  cooperation. Bundles are best-effort (fired same-tick) and the API says so.
- **Simulation is a strong signal, not a guarantee.** State can shift between
  `eth_call` and inclusion.
- **Rebates are off-chain accounting in Phase 1.** The split math and
  attribution are final; trustless on-chain settlement is Phase 2.
- **USD value is quote-denominated.** Only profits ending in WETH/stablecoins
  are priced; long-tail token inventory is counted but not valued, to keep the
  headline number honest.
- **Public RPC rate-limits.** Sustained measurement needs a dedicated endpoint
  or our own Nitro node — which is also step one of colocation.

## Roadmap

1. **Phase 1 (this repo):** execution services — gateway, auction, measurement.
2. **Phase 2:** own Nitro node colocated in us-east-2, sequencer-feed decoding
   for sub-block latency, on-chain settlement contract for trustless rebates.
3. **Phase 3:** sequencer integration with Robinhood — verifiable ordering
   attestations, programmable per-app sequencing, Timeboost-style express-lane
   auctions, and true atomic bundles.
