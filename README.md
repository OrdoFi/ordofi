# OrdoFi

**The execution layer for Robinhood Chain.**

OrdoFi is what Jito's BAM is to Solana, built for Robinhood Chain (Arbitrum
Nitro L2, chain ID 4663): private transaction submission, revert protection,
best-effort bundles, a backrun order-flow auction, and MEV revenue shared back
to the apps and users who create it. Built by OrdoFi Labs. *Ordo* — Latin:
order, sequence.

> Not affiliated with Robinhood Markets, Inc.

## Deployed on Robinhood Chain

| Contract | Address |
| --- | --- |
| `OrdoSettlement` | `0xbC680922DaF2F65a8B957e5238857f8c68BeDabb` |
| `OrdoBundler` | `0xc0bccFb3aA4ad9160d272645376a1797a32f3c4a` |
| `OrdoReceiptLog` | `0x89926c06cad403fDDD481C599b2ce709EBC936B9` |

Live at block 51544378 with a 90/5/5 user/app/protocol split. Foundry's receipt
output labelled these two the wrong way round; the pairing above is the one the
chain reports, read back from `owner()` and `executorOf()`.

**First settlement, 2026-09-01.** A bonded searcher won a sealed-bid auction at
a 0.0002 ETH clearing price and settlement landed on-chain three blocks after
the user's transaction: 90% became claimable by the user, 5% by the
originating app, 5% by the treasury — conserved to the wei, verifiable at
[`0xd34ed319…`](https://rpc.mainnet.chain.robinhood.com) (settlement,
block 51654346) against user transaction `0x82235bda…` (block 51654343). The
auction issued a signed receipt for the round, with the winning bid carrying
the searcher's own EIP-712 signature.

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
| `apps/web` | 3000 | Full site: landing, **Explorer** (`/explorer`, live network monitoring), onboarding for `/searchers` `/apps` `/operators`, `/docs`, and on-chain `/dashboard` |
| `apps/searcher-bot` | — | Reference searcher bot: connects to the auction, signs EIP-712 bids, submits backruns |
| `packages/sdk` | — | `@ordofi/sdk` — searcher/app SDK (bid signing, bond management, order-flow submission) |
| `contracts` | — | `OrdoSettlement.sol` — on-chain bonded settlement for the auction (Foundry) |

### Searcher SDK

```ts
import { OrdoSearcher } from "@ordofi/sdk";

const searcher = new OrdoSearcher({
  auctionWsUrl: "wss://auction.ordofi.network/searcher",
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

## Verifiable auction outcomes

A sealed-bid auction asks searchers to take the operator's word for the bids
they never see. They should not have to. Every bid is acknowledged the instant
it arrives, and every closed round publishes a receipt listing all of them —
both signed by the auctioneer under EIP-712, so a mismatch between the two is
evidence rather than a complaint.

```bash
curl auction.ordofi.network/receipts/$OPPORTUNITY_ID   # one round, bids and all
curl auction.ordofi.network/receipts/root              # { root, count, anchoredCount }
```

`auditReceipt()` in `packages/core/src/receipt.ts` is the check a searcher
actually runs, and it needs to trust nothing said after the fact: the
acknowledged bid must appear in the receipt at the acknowledged amount, every
listed bid must carry that searcher's own settlement signature, and the winner
must be the highest bidder charged the second-highest price.

Signatures make a single receipt unforgeable but do not stop one being swapped
out after publication, so a Merkle root over the whole history is batched into
`OrdoReceiptLog` on-chain. `anchoredCount` is the prefix already immutable; the
gap to `count` bounds what a malicious operator could still retract. The log is
rehydrated from disk at boot and the committed count is read back from the
chain, because an auction that restarted believing it had issued nothing would
publish a shrinking root — which the contract rejects, by design.

## Sequencer feed relay

MEV on an FCFS chain is a latency race, and the sequencer feed is where it
starts. The auction holds one upstream connection to
`wss://feed.mainnet.chain.robinhood.com`, decodes the Nitro batch framing
(sub-messages carry a **uint64** big-endian length prefix — a 4-byte reader
silently decodes about one transaction in a thousand), and fans raw
transactions out to searchers:

```bash
websocat ws://localhost:8548/feed     # { type: "feed_txs", txs: [{ hash, raw }], … }
curl localhost:8548/feed/stats        # upstream health, txsRelayed, reconnects
```

`receivedAt` is stamped on arrival so searchers can measure the relay's added
latency rather than assume it. This is a head start on decoding, not a preview
of pending order flow — the feed carries transactions the sequencer has already
ordered. Pending flow is what the auction is for.

## Atomic bundles

`contracts/OrdoBundler.sol` is the answer to "can you do Jito bundles here". A
searcher calls `OrdoBundler.deploy()` once to get their own `OrdoExecutor` at a
CREATE2 address derived from their own — so the address is known before it
exists, and allowances granted to it can only ever be spent by the account that
granted them. Then:

```solidity
executor.execute(calls, checks, maxBlock, minGainWei);
```

Every call runs in one transaction: all of them land or none do. `checks` are
preconditions read off live state before the first call, so a bundle can refuse
to run when the trade it was meant to follow has not landed. `minGainWei` makes
an unprofitable bundle revert rather than settle.

The fork test is the demonstration. The SCL market's buyback holds 1.26 ETH,
has never fired, and cannot: it spends its whole balance in one swap and
refuses a fill worse than 5% below spot, which 1.26 ETH cannot achieve against
that pool. One bundle — buy to deepen, burn, sell back — unsticks it, and
either every leg lands or the searcher is out nothing but gas:

```bash
npm run fork-proxy &          # the public endpoint refuses Foundry
cd contracts && forge test --match-contract OrdoBundlerFork --fork-url http://127.0.0.1:8545 -vv
```

```
[PASS] test_Fork_AtomicBundleUnsticksTheBurn()
  deepening buy:        14.000000000000000000
  SCL burned:           3088573
  searcher cost (wei):   0.292654556741677170
```

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

- **Own Nitro node** (`deploy/nitro-node/`) — pruned full node with `debug_*`
  enabled, restored from a published snapshot rather than synced from genesis
  (the chain's early L1 blobs are past ordinary beacon retention). Specced for
  Vultr bare metal in Chicago at $365/month; disk grows ~230 GB/month, which is
  the number that actually decides the machine. See its README.
- **Edge + services** (`deploy/docker-compose.prod.yml` + `deploy/Caddyfile`) —
  gateway, auction, web, and watcher behind Caddy with automatic TLS at
  `rpc.ordofi.network`, `auction.ordofi.network`, `app.ordofi.network`. The apex
  stays with the Framer marketing site.

Run from the repo root and pass the root `.env` explicitly. Compose otherwise
looks for a `.env` beside the compose file, finds none, and starts every
service unconfigured — no settlement key, no contract addresses:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```

## Tests & CI

- `npm test` — unit tests for detection, auction resolution, rebate math, rate limiting.
- `cd contracts && forge test` — 19 contract tests incl. fuzz + fork + security guards.
- CI workflow provided at `deploy/github-ci.yml` — move to `.github/workflows/`
  to run typecheck, unit tests, and forge tests on every push.

## The revenue loop (closed)

With `ORDO_SETTLEMENT_ADDRESS` and `ORDO_AUCTIONEER_KEY` configured, the auction
collects real money end to end:

1. Searchers bond ETH into `OrdoSettlement`.
2. **Bond gating** — the auction rejects any bid the searcher can't cover
   on-chain, so it never sells something it can't collect.
3. On a win, the auctioneer submits `settle()` automatically. The contract
   verifies the searcher's own EIP-712 signature, debits the bond, and credits
   claimable balances.
4. The rebate is credited to the **recovered sender of the user transaction**,
   the originating app, and the protocol.

Verified end to end against a local chain: a bonded searcher signed a 0.01 ETH
bid, won, and settlement landed on-chain — `0.009 ETH` claimable by the user and
`0.0005 ETH` by the app. An over-sized bid from the same searcher was rejected
with `insufficient bond`.

```bash
npm run auction    # logs: bond gating=on · on-chain settlement=on
node apps/auction/test-settlement.mjs   # end-to-end proof
```

## Public API (for the marketing site)

All `/api/*` endpoints are CORS-open so an external site (e.g. a Framer build)
can embed live numbers directly.

```js
const s = await fetch("https://app.ordofi.network/api/stats").then(r => r.json());
// { arbs, searchers, activeSearchers24h, pools, swaps, arbsPerDay, ethUsd,
//   routed: { transactions, transactions24h, volumeUsd, volume24hUsd, since },
//   settlement: { deployed, settlements, totalSettledEth, rebatesToUsersEth, rebatesToAppsEth, ... },
//   mevObserved: { usd24h, arbs24h, usdAllTime, arbsAllTime, floor: true },
//   rebateSplit: { user: 0.9, app: 0.05, protocol: 0.05 },
//   headline: { protectedVolumeUsd, transactions, mevObservedUsd24h, rebateSplit,
//               mevCapturedEth, rebatesReturnedEth, activeSearchers24h, ... } }
// `headline` is the five-figure strip on the home and RPC pages: protected volume
// and transactions are what went through rpc.ordofi.network; MEV observed is the
// arbitrage the watcher saw land on-chain, priced in quote assets only (a floor)
// and explicitly not what OrdoFi captured; the rebate split is the one the
// contract enforces; active searchers landed an arb in the last 24h. What the
// auction has actually settled (mevCaptured*, rebatesReturned*) stays in the
// payload and on /dashboard.
```

| Endpoint | Returns |
| --- | --- |
| `GET /api/stats` | Compact, embed-friendly headline numbers |
| `GET /api/explorer` | Full feed: report, recent arbs, auction stats, on-chain |
| `GET /api/arbs/recent?n=40` | Recent atomic arbitrages |
| `GET /api/onchain` | Settlement contract state and recent settlements |
| `POST /api/keys` | Self-serve API key issuance (returned once, stored hashed) |
| `GET /api/account?address=` | Bond, claimable rebates, and settlement history for one address |

The auction serves its own, also CORS-open: `GET /receipts`, `/receipts/root`,
`/receipts/:id`, `/feed/stats`, `/stats`. Keys are mintable from the browser at
[`/portal`](https://app.ordofi.network/portal).

## Design honesty

- **Atomicity is per-sender, not cross-sender.** `OrdoExecutor` makes every leg
  of one transaction succeed or fail together, which is what a searcher needs
  for their own legs. A user's trade and someone else's backrun landing
  *adjacent* cannot be guaranteed without the sequencer, and nothing here
  pretends otherwise — `ordo_sendBundle` returns `atomic: false` for
  multi-transaction bundles and points at the executor instead. What the
  executor's preconditions buy across senders is the weaker but real guarantee
  that a backrun refuses to execute on stale state rather than filling at a
  price that no longer exists.
- **Simulation is a strong signal, not a guarantee.** State can shift between
  `eth_simulateV1` and inclusion.
- **Hints leak direction, not size.** At the default `pools` level a searcher
  learns which pools move and which way — enough to price a backrun, not enough
  to front-run. `ORDO_HINT_LEVEL=full` discloses amounts; that is a deliberate
  choice with a real cost.
- **The auction delays the user's transaction** by the bid window (200ms by
  default). `/submit` reports the actual figure as `auctionDelayMs`.
- **On-chain settlement is deployed, but a service only uses it if configured.**
  `OrdoSettlement` is live at `0xbC680922DaF2F65a8B957e5238857f8c68BeDabb`;
  an auction started without `ORDO_SETTLEMENT_ADDRESS` and `ORDO_AUCTIONEER_KEY`
  still runs, but its rebates are off-chain accounting that collects nothing.
  The services log which mode they are in at boot.
- **USD value is quote-denominated.** Only profits ending in WETH/stablecoins
  are priced; long-tail token inventory is counted but not valued, to keep the
  headline number honest.
- **The public RPC is not a foundation.** It has `eth_simulateV1` but no
  `debug_*` and no archive state, rate limits hard, and serves Foundry a
  Cloudflare challenge. Run `npm run node-check` to see it for yourself, and
  `npm run fork-proxy` to work around it until the node in
  `deploy/nitro-node/` is up.

## Roadmap

1. **Phase 1 (this repo):** execution services — gateway, auction, measurement.
2. **Phase 2:** own Nitro node close to the sequencer, sequencer-feed decoding
   for sub-block latency, on-chain settlement contract for trustless rebates.
   The feed relay and settlement contract are live; the node is specced.
3. **Phase 3:** sequencer integration with Robinhood — verifiable ordering
   attestations, programmable per-app sequencing, Timeboost-style express-lane
   auctions, and true atomic bundles.
