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
reaching the sequencer. The single-instance → two-replica migration and two forced rolling restarts
under ~85 req/s, behind a local Caddy with the production proxy settings:
0 failed requests out of ~10,000. (Caddy's `dynamic a` upstreams were tried
first and rejected: active health checks do not run on dynamic upstreams, and
without them one request in a few thousand hit a closing keep-alive connection.)

### One-time step that causes a ~1–2 s blip

HTTP/3 needs Caddy to own 443/udp, which means recreating the Caddy container
once. Certificates are on a volume, so it is back in about a second, but every
host (app, rpc, auction) blips. Do it at a quiet hour:

```bash
ssh ordofi 'cd /opt/ordofi && docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --no-deps caddy'
```

Until then everything else in the Caddyfile is live through a graceful reload.

## Cloudflare in front (needs the Cloudflare account)

What it buys: TLS terminates near the user and Cloudflare keeps warm
connections to Chicago. For the European wallet above, a cold request goes
from ~530 ms to ~250 ms; HTTP/2 and HTTP/3 are automatic; and the origin is
hidden behind anycast.

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
8. Gateway: nothing to change. `clientIp()` already reads the first
   `x-forwarded-for` hop, which Cloudflare sets to the real client, so the
   per-IP limits keep working. Optionally restrict Caddy's `rpc` host to
   Cloudflare's IP ranges once traffic is confirmed to flow through the edge.

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
