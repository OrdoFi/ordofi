# Making rpc.ordofi.network faster: what is done, what needs an account

Measured 3 Sep 2026. The gateway on the app server (Vultr, Chicago, 2 vCPU /
3.3 GB) reaches the sequencer's public RPC in ~45–50 ms; a European wallet
reaches the gateway in ~110 ms per round trip, plus a TLS handshake on a cold
connection.

## Shipped in the gateway (no account needed)

| Change | Effect |
| --- | --- |
| `eth_chainId` / `net_version` answered in-process | 0 ms and no upstream call for the 2nd/3rd most-called methods |
| `eth_blockNumber`, head block cached 100 ms; fee data 1 s; mined receipts/txs 10 min | the most-called method leaves the process at most 10×/s regardless of how many wallets poll |
| identical concurrent reads coalesced | a burst of 25 `eth_blockNumber` = 1 upstream call |
| hedged reads (after 150 ms, to the second upstream) | the ~950 ms p99 becomes roughly the p95 |
| protected send = one `eth_simulateV1` + send | 2 round trips instead of 3, ~50 ms off every send |
| locally answered reads exempt from the anon limit; 3,000 upstream reads/min/IP; sends 60/min/IP | dapps behind one NAT stop seeing 429s |
| two gateway replicas (`gateway-a`/`gateway-b`), Caddy active health checks + retry-on-dial, `deploy/rollout.sh` | deploys no longer 502 anyone mid-transaction |
| `cpu_shares`: gateway 2048, watcher 512, backfill 256 | the gateway gets the core first when the box is busy |
| `encode zstd gzip`; 443/udp published for HTTP/3 (needs one Caddy recreate, see below) | smaller bodies, fewer round trips for browsers |

Verified locally against the real chain: `eth_chainId` 0.3 ms, cached
`eth_blockNumber` 0.4 ms (was one upstream trip each), 25 concurrent
`eth_blockNumber` → 1 distinct answer, receipt second fetch 13 ms vs 256 ms,
`ordo_simulate` ~140 ms from Europe, a burn to `0x0` refused in 60 ms without
reaching the sequencer. Rolling restarts, measured: the single-instance → two-replica migration and
four forced replacements of both replicas under ~85 req/s behind a local Caddy
with the production proxy settings, 0 failed requests out of 14,148; then the
production migration and a forced production rollout probed from Europe over
TLS, 0 failed out of 1,491. (Caddy's `dynamic a` upstreams were tried first
and rejected: active health checks do not run on dynamic upstreams, and
without them about one request in three thousand hit a closing keep-alive
connection.)

Live after the rollout, from Europe: `eth_chainId` 130 ms, which is the
network round trip itself (ping 135 ms) — the gateway now adds nothing; before,
168 ms. Inside the box: `eth_chainId` and a cached `eth_blockNumber` answer in
4–7 ms against ~31 ms before.

### HTTP/3: done (3 Sep, 10:45 CEST)

HTTP/3 needed Caddy to own 443/udp, which meant recreating the Caddy container
once; the same recreate also refreshed the Caddyfile bind mount. Measured from
Europe with a 100 ms probe: 0.8 s unavailable (4 probes of 72), certificates
untouched, back with `alt-svc: h3=":443"` on every host. If it ever has to be
repeated, the command is

```bash
ssh ordofi 'cd /opt/ordofi && docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --no-deps caddy'
```

and it is safe as long as `docker compose ... up -d --dry-run` first shows the
gateway replicas as `Running`, not `Recreate`: that dry run is what caught the
compose file having been overwritten by a commit made against a stale copy
(restored in `aa1c8a4`). Read the dry run before any `up -d` on this box.

## Cloudflare in front: done (3 Sep, active 11:31 CEST)

What it buys: TLS terminates near the user and Cloudflare keeps warm
connections to Chicago. Measured from Berlin once the zone went active: a
cold `eth_chainId` 0.25 s against 0.40 s an hour earlier, the TLS handshake
80 ms instead of 260 ms (it now happens at the `TXL` edge); HTTP/2 negotiated,
`alt-svc: h3` advertised; `cf-cache-status: DYNAMIC` on every JSON-RPC
response. Foundry (`cast block-number`, `chain-id`, `balance`), curl with an
empty, Python and Go user agent, and a minute of MetaMask-style polling
(60 calls across six methods) all answered 200 with no challenge. The zone is
`ordofi.network` on the Free plan, nameservers `hans`/`selah.ns.cloudflare.com`;
only `rpc` is proxied, `app`, `auction`, the apex and `www` are DNS-only and
resolve exactly as they did at Namecheap; the MX and SPF records came across.

One thing point 8 below got wrong, caught by capturing what reached the
gateway: Caddy does not trust `x-forwarded-for` from a peer it does not know,
so behind Cloudflare that header named the edge node, and every wallet on one
edge would have shared a single anonymous budget. The gateway now keys on
`Cf-Connecting-Ip`, which Cloudflare overwrites on the way in, and Caddy strips
that header from any request whose peer is outside Cloudflare's published
ranges, so a direct hit on the origin cannot choose its own key (`bb4ed78`;
verified both ways with tcpdump on port 8547). The steps as they were written,
for the record:

What it must not do: challenge JSON-RPC. The public Robinhood endpoint's bot
check is exactly what makes it unusable for Foundry and for any non-browser
client, and inheriting that would be worse than the latency it saves.

1. Add `ordofi.network` to Cloudflare (or just delegate the `rpc` label with a
   CNAME setup, if the apex stays where it is for the Framer site).
2. DNS: `rpc.ordofi.network` A → `64.177.14.42`, **proxied** (orange cloud).
   Leave `app` and `auction` as they are for now; `auction` carries the
   searcher WebSocket and should be measured separately before proxying.
3. SSL/TLS → **Full (strict)**. Caddy already holds a valid certificate for
   the host, so the edge-to-origin hop stays verified.
4. Security → WAF → Custom rules, first rule, for hostname
   `rpc.ordofi.network`: action **Skip** → all remaining custom rules,
   rate limiting rules, managed rules, and *Bot Fight Mode / Super Bot Fight
   Mode*. Also **Security level: Essentially Off** for this host via a
   Configuration Rule, and **Browser Integrity Check: off**. This is the
   "never challenge POSTs" part; test with
   `curl -X POST https://rpc.ordofi.network -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' -H 'content-type: application/json'`
   from a machine that has never seen a Cloudflare cookie, and with Foundry:
   `cast block-number --rpc-url https://rpc.ordofi.network`.
5. Speed → **HTTP/3 (with QUIC)** on, **0-RTT** on, **Brotli** on.
6. Caching → a Cache Rule for `rpc.ordofi.network`: **Bypass cache**. JSON-RPC
   is POST and would not be cached anyway, but the landing page at `/` is fine
   to cache and `/health` is not; bypass is the safe default.
7. Network → **WebSockets** on (harmless here, required if `auction` is
   proxied later).
8. Gateway: ~~nothing to change~~ — see above; `clientIp()` in
   `apps/gateway/src/fastpath.ts` and the `@not_cloudflare` matcher in the
   Caddyfile are the fix. Still open: restrict Caddy's `rpc` host to
   Cloudflare's ranges outright, now that traffic is confirmed to flow through
   the edge, so the origin cannot be hit directly at all.

## The edge Worker and Argo: done (3 Sep, 13:09 CEST)

`deploy/edge-worker` runs in every Cloudflare city on `rpc.ordofi.network/*`
(`npx wrangler deploy` from that directory). It answers what the gateway's own
fast path answers — `eth_chainId`, `net_version`, and for one window each the
head, gas and fee data, mined receipts and transactions — from the city the
wallet is in, and forwards everything else to Chicago in the request the client
made, headers included, returning the origin's answer untouched. The
`x-ordo-edge` response header says which happened: `hit`, `pass` or `mixed`
(a batch answered partly here). Verified live: `eth_chainId` `hit` from `CDG`,
`eth_getBalance` and a send `pass`, a malformed send comes back with the
origin's exact error, a three-method batch merges, `/` and `/health` untouched.
Argo Smart Routing was switched on at 13:04 the same day.

Measured from Europe, 20 warm requests each, before → after, against the two
public endpoints:

| method | ordo before | **ordo now** | rpc.mainnet.chain.robinhood.com | robinhood-rpc.publicnode.com |
| --- | --- | --- | --- | --- |
| `eth_chainId` p50 | 130 ms | **41 ms** | 147 ms | 41 ms |
| `eth_gasPrice` p50 | ~180 ms | **42 ms** | 140 ms | 50 ms |
| `eth_blockNumber` p50 | ~180 ms | **68 ms** | 147 ms | 42 ms |
| `eth_getBalance` p50 (never cached) | ~180 ms | 184 ms | 144 ms | 46 ms |
| cold `eth_chainId` (new TLS) | 250 ms | **118 ms** | 213 ms | 127 ms |

So on the calls a wallet makes most, the RPC is now 3–4× faster than
Robinhood's own endpoint and level with publicnode, from Europe, with the
origin still in Chicago. The `eth_blockNumber` figure is between the two
because the window is one block (100 ms) and sequential requests mostly miss
it; under real polling from many wallets in a city the hit rate is far higher.

What the table also says: an uncacheable read (`eth_call`, balances, nonces)
is Europe → edge (~15 ms) → Chicago (~100 ms) → Robinhood's RPC (46 ms measured
from the box) and back, ~184 ms, and publicnode answers the same call in 46 ms
because it has a node in Europe. No routing product changes that; Argo's
effect on the pass-through path was not measurable today (the Chicago hop was
already on a warm connection), and it can be switched off again if its
analytics show nothing after a day. The only thing that beats publicnode on
`eth_call` from Europe is a node in Europe: the pending Frankfurt box should
carry the Nitro node as a read replica, with the gateway in edge mode
(`ORDO_EDGE_ORIGIN`) in front of it, so that European reads never cross the
Atlantic and only sends do — and those must, because the sequencer is in the US.

## The Nitro node: what is actually there

`deploy/nitro-node/README.md` was written for Vultr bare metal in Chicago. The
node that exists is not that machine. Measured:

| | |
| --- | --- |
| Host | `ordofi-node` = 107.155.92.14, Hivelocity, **Sunnyvale, California** |
| Hardware | 48 cores, 503 GB RAM, `/data` 2.8 TB RAID (942 GB used) |
| Nitro | `ordofi-node-nitro-1`, up 32 h, RPC bound to 127.0.0.1 only (correct) |
| Sync | block 50.16 M vs target 53.22 M — **~3.06 M behind**, gaining ~22 blocks/s net → **~1.5–2 days** to catch up if the rate holds |
| RTT app server → node | **48 ms** (same as app server → public RPC) |
| Node → sequencer RPC | 90–200 ms (vs 45–50 ms from Chicago) |
| DNS `node.ordofi.network` | no record |

So the node will remove rate limits, Cloudflare challenges and stale heads,
and it will make `debug_*` available, but **it does not cut the gateway's
simulation latency while the gateway stays in Chicago**: 48 ms to Sunnyvale is
the same as 48 ms to the public endpoint. The latency win only appears if the
gateway and the node share a machine or a metro.

### When it is synced (check with `eth_syncing` returning `false`)

1. Expose the node to the app server only. Do not open 8547 to the world; an
   open node with `debug_*` is someone else's free infrastructure. Two options:
   - a WireGuard tunnel app-server ↔ node (10 minutes, no provider dependency), or
   - keep 127.0.0.1 binding and add an `ssh -N -L` tunnel as a systemd unit on
     the app server (simplest; ~1 ms extra).
2. Put it first for the light services only, keep the public list as backup:
   ```bash
   # /opt/ordofi/.env on the app server
   ORDO_RPC_URLS_LIGHT=http://<tunnel-ip>:8547,https://robinhood-mainnet.core.chainstack.com/…,https://rpc.mainnet.chain.robinhood.com
   ```
   then `ORDO_ROLLOUT_FORCE=1 bash deploy/rollout.sh --no-build` for the
   gateway (env-only change), and `up -d` for auction/web/arb when convenient.
3. Watch `hedge_won_total` in `/metrics`: if the hedge (public RPC) keeps
   winning against the node, the node is lagging and should not lead the list.

### The structural options, honestly

- **A. Keep the gateway in Chicago, node in Sunnyvale (as is).** Sends land
  as fast as today; reads and simulations stay ~50 ms but become unlimited
  and unchallenged. Cheapest; already paid for.
- **B. Run a second gateway replica on the node box, reads/simulate local.**
  Simulation becomes <1 ms, but a send from Sunnyvale reaches the sequencer
  (AWS us-east-2, Ohio) ~30–40 ms later than from Chicago, and on a
  first-come-first-served chain that is the wrong direction for the one call
  that matters. Would need Caddy to split sends and reads by method (Caddy
  cannot route on JSON body; a small gateway change to forward sends to the
  Chicago replica would do it).
- **C. Move the node to Chicago or Ohio.** Hivelocity has Chicago; AWS
  us-east-2 is where the sequencer is. A node in Ohio makes both the
  simulation and the send as short as they can physically be. Snapshot restore
  is ~1 day; the current node keeps serving until the new one is synced.
  This is the only option that makes "fastest" true for sends, and it is a
  provisioning decision with a monthly cost, so it is yours.
