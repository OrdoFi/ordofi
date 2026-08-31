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
| `apps/web` | 3000 | Landing page + docs, wired to the live report |

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
