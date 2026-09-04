# Ordo VIA — the Verifiable Inclusion Auction

*Send it via Ordo.*

Jito's BAM separates the scheduler from the block producer, runs it in an
enclave so it can order transactions without being able to cheat, and lets
applications install their own ordering rules. It works because Jito's client
runs most of Solana's stake.

We do not run Robinhood Chain's sequencer and never will. What we run is the
thing in front of it: a gateway that holds a transaction for the length of one
simulation, auctions the right to back-run it, and forwards it to the
sequencer. That is a scheduler for the flow that passes through it, and VIA is
the name for making it verifiable, programmable, and — if the chain owner ever
opens the express lane — fast in a way nobody else can be.

The name carries both senses on purpose. *Via* is the road; it is also how you
already say that a transaction went through us.

## The four parts

### 1. The Auction — live

A transaction submitted through the RPC creates an opportunity. Bonded
searchers bid for the right to back-run it in a sealed-bid, second-price
round; the winner pays the runner-up's price, and `OrdoSettlement` splits it
90% to the user whose transaction created it, 5% to the app that sent them,
5% to the treasury, conserved to the wei.

The verifiable part is already built and running (`apps/auction`,
`packages/core/src/receipt.ts`):

- every bid is acknowledged the instant it arrives, signed by the auctioneer
  under EIP-712;
- every closed round publishes a receipt listing **all** bids, each carrying
  the searcher's own settlement signature, so the operator cannot invent a
  runner-up to raise the clearing price — the attack second-price pricing
  would otherwise make directly profitable;
- `auditReceipt()` checks that the acknowledged bid appears at the
  acknowledged amount, that the winner was the highest bidder, and that it was
  charged the second-highest price;
- a Merkle root over every receipt ever issued is batched into
  `OrdoReceiptLog` on-chain, so a receipt cannot be swapped out after
  publication. `anchoredCount` is the prefix already immutable; the gap to
  `count` bounds what a malicious operator could still retract.

What is missing is not machinery, it is participants. As of 4 Sep 2026 the
auction has seen one opportunity and zero bids, because almost no flow routes
through the RPC and the only connected searcher is our own placeholder. A
verifiable auction with no bidders returns a verifiable zero.

### 2. The Seal — planned

The gateway decides what happens to a transaction between the wallet and the
sequencer. Today "we do not log you, we do not read your transaction for our
own benefit, we do not reorder you" is a promise on a web page, which is what
every RPC says and most do not keep: read the privacy statements on Chainlist
and count how many admit to logging IPs and correlating them with wallet
addresses.

Running the gateway inside a TEE (Intel TDX, or AWS Nitro Enclaves) with
reproducible builds and a published attestation turns that promise into
something a wallet or a searcher can check: the code handling the transaction
is the code we published, and no operator — including us — can read or reorder
what it holds.

This is also load-bearing for everything after it. Apps will not hand their
ordering rules to a black box, and searchers will not bid aggressively into an
auction run by an operator who also runs a house bot, unless the neutrality is
checkable rather than asserted.

Open: which host (the app server is a Vultr instance without TDX), the
reproducible build pipeline, key management inside the enclave, and how the
attestation is served and pinned.

### 3. Routes — planned

An application that sends us its users' flow declares the ordering policy for
*its own* flow. The useful ones on this chain are concrete:

- a launchpad: for the first N seconds of a token's life, buys are ordered
  strictly by arrival and no bundle interleaves;
- an app: its users' transactions never share a block with a back-run unless
  that back-run pays into the app's rebate pool;
- an order-book style venue: cancels ahead of fills.

The honest limit: we order only what routes through us. Anyone who does not
use Ordo is still ordered first-come-first-served by the sequencer and can
land between our transactions. Until we hold the express lane, a Route is
best-effort — which is why the enforceable version of the launch case is an
**atomic bundle** through `OrdoBundler` (pool initialize, seed, first buys in
one transaction, nothing can interleave by construction), and why that is the
first thing to build.

### 4. VIA Express — needs the chain owner

Arbitrum Nitro ships Timeboost: a sealed-bid second-price auction, by default
every 60 seconds, that sells control of an *express lane*. The winner's
transactions are sequenced immediately; everyone else's are delayed 200 ms.

Robinhood Chain has it switched off — probed 4 Sep 2026,
`timeboost_sendExpressLaneTransaction` returns "does not exist", on a
sequencer running `nitro/v3.11.4-rc.3`, which supports it. So this is a
configuration choice, not a limitation.

The detail that makes it a product rather than a bot edge: the express lane
controller may apply the time advantage to transactions *signed by other
parties*. If Ordo holds the lane, every transaction routed through us skips
the delay everyone else eats, and the back-run rights inside the lane are
auctioned in VIA.

Two honest cautions. On a chain with 100 ms blocks a 200 ms delay for
non-express users is two blocks, which is a real reason the chain owner may
decline. And Arbitrum One is currently moving away from Timeboost toward
priority gas auctions after its proceeds consolidated among a few bidders
(~$0.52M for the whole chain in H1 2026). Worth asking for; not worth
building on.

## What exists today, precisely

| Piece | Status |
| --- | --- |
| Sealed-bid second-price auction, bonded searchers | live (`apps/auction`) |
| Signed bid acknowledgements and receipts, `auditReceipt()` | live |
| Merkle root anchored in `OrdoReceiptLog` | live, anchoring on |
| 90/5/5 split enforced on-chain | live (`OrdoSettlement`) |
| Sequencer feed relay to searchers | live |
| Real bidders | **no** — one placeholder bot |
| Flow to auction | **almost none** — this is the binding constraint |
| The Seal | not started |
| Routes | not started |
| VIA Express | blocked on the chain owner |

## Build order

1. **The VIA page** at `auction.ordofi.network` — the receipts exist and
   nobody can see them. Make the auction legible: rounds, bids, winners,
   clearing prices, the root, the anchor, and the command to verify it
   yourself. Credibility is what recruits both apps and searchers.
2. **The atomic protected launch** on `OrdoBundler` — the enforceable Route,
   and the thing to sell a launchpad.
3. **A real house searcher** — merge the arb bot's opportunity detection into
   the searcher bot's bid flow so the auction has a genuine floor, bidding
   through VIA like anyone else, so its wins on Ordo-routed flow are rebated
   90% exactly as a stranger's would be.
4. **The Seal.**
5. **VIA Express**, if the chain owner opens it.

## Naming

Always "Ordo VIA", never bare `VIA` — an old altcoin holds that ticker and we
have a token of our own; the pair would be read as one. Three sub-terms and no
more: a **Route** is an app's ordering policy, the **Seal** is the enclave
attestation, **VIA Express** is the express lane.
