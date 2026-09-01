# OrdoFi Nitro node

A Robinhood Chain full node with `debug_*` enabled, run on hardware we control.

## Why

Three things the public endpoint cannot give us, in order of how much they
matter:

1. **`debug_traceTransaction`.** MEV attribution from logs alone is inference.
   Tracing turns a guess into a measurement, and the leakage numbers we put in
   front of anyone should be measurements.
2. **Latency to the sequencer.** Robinhood Chain orders first-come-first-served
   with no public mempool, so the only thing deciding who wins a backrun is who
   reaches the sequencer first. Distance is the product.
3. **No rate limit and no Cloudflare challenge.** The watcher currently backs
   off against a public endpoint that intermittently serves 403 bot challenges,
   and Foundry cannot talk to it at all without `scripts/fork-proxy.mjs`.

## Pruned, not archive

Deliberate. Backrun attribution traces transactions as they land, which a
pruned node does; archive retains every historical state root, which nothing
here reads. The difference is roughly double the disk and 14 GB/day instead of
7.6 GB/day of growth.

The cost of the choice, stated plainly: historical `eth_call` and fork tests
against old blocks will not work on this node, and `scripts/node-check.mjs`
will report its "archive state (-200k blocks)" line as a failure. That line
failing is the configuration working as intended.

## Machine

Robinhood's own guidance is 8+ cores with strong single-core performance,
64 GB RAM (128 recommended), locally attached NVMe, and `(2 × chain size) + 20%`
of disk. Networked storage "will significantly throttle sync speed" — so no
block storage, no SAN.

The pick:

| | |
| --- | --- |
| Plan | `vbm-8c-64gb-amd` (bare metal) |
| CPU | EPYC 4345P, 8 cores / 16 threads @ 3.9 GHz |
| RAM | 64 GB |
| Disk | 2 × 1945 GB **NVMe** |
| Region | `ord` (Chicago) |
| Cost | **$365/month** |

Chicago rather than New Jersey for two reasons that both happen to point the
same way: the app server is already there, so the two can talk over a private
network instead of the public internet, and Chicago is nearer to the
sequencer's region (AWS us-east-2, Ohio) than New Jersey is.

Provision it with the two disks **striped, not mirrored** (`disk_mode` of
`raid0`, or `none` and let `bootstrap.sh` stripe them). Mirrored gives 1.9 TB
usable and works, but the restore alone peaks near 930 GB — downloaded parts
plus the extracted database — so it would start life with about four months of
runway instead of fourteen.

Bare metal beats the cloud plans on every axis that matters here: the closest
64 GB NVMe cloud instance in `ord` is $390/month for 800 GB, and shared-tenancy
vCPU is the wrong thing to put under a node in a latency race.

64 GB is Robinhood's stated minimum against a recommendation of 128 GB. The
128 GB bare metal machines (`vbm-8c-132gb`, `-v2`) carry comparable NVMe but
are not offered in Chicago, so taking them would mean giving up both the
private link to the app server and the shorter hop to Ohio — and they are
slower per core, at 3.2–3.7 GHz against 3.9, which is the figure Robinhood's
guidance actually emphasises. If memory turns out to be the binding constraint,
`voc-m-16c-128gb-1600s-amd` is the in-region fallback at $785/month.

### Disk is the real cost, and it compounds

Measured from the published snapshot sizes on consecutive dates:

| Snapshot kind | Size (26 Aug) | Growth |
| --- | --- | --- |
| Pruned (what we run) | 434 GiB | 7.6 GB/day, ~230 GB/month |
| Full, path scheme | 582 GB | 12.1 GB/day |
| Archive | 701 GB | 13.9 GB/day |

At 0.1s blocks this chain produces about 26 million blocks a month, and a
pruned node keeps every block and receipt forever — only state is pruned. So
3.89 TB striped gives roughly **fourteen months** after a restore, and this is
a standing ~230 GB/month commitment rather than a one-time purchase. Plan on
migrating to a larger box eventually, not on the number staying still.

## L1 prerequisites

Robinhood Chain posts its data to **Ethereum mainnet**, so the node needs both:

- an L1 execution RPC endpoint, and
- an L1 **beacon** endpoint, which is what serves blob data.

Most beacon nodes retain blobs for about 18 days. The chain launched in July
2026, so a sync from genesis would need a blob *archive*. Restoring from a
published snapshot sidesteps this entirely: the node only ever asks for recent
blobs, which any ordinary beacon endpoint has. This is the main reason the
restore is not optional.

Initial catch-up still consumes real L1 request quota — watch the provider's
usage during the first day.

## Bringing it up

```bash
# on the host, as root
git clone <repo> /tmp/ordo && cd /tmp/ordo/deploy/nitro-node
RAID0=yes ./bootstrap.sh          # storage, Docker, config, snapshot URL
cp docker-compose.yml /opt/ordofi-node/
vi /opt/ordofi-node/.env          # fill in L1_RPC_URL and L1_BEACON_URL
cd /opt/ordofi-node && docker compose up -d && docker compose logs -f
```

`bootstrap.sh` resolves the current pruned snapshot from Arbitrum's snapshot
explorer and writes it to `.env` as `NITRO_INIT_URL`. It stops short of
starting the node, because a restore begun with the wrong disk mounted or no L1
endpoint wastes hours and a few hundred gigabytes of someone's bandwidth.

Expect the first run to take hours. Watch that `/data` does not fill.

## Verifying

```bash
# caught up when this returns false
curl -s -d '{"id":0,"jsonrpc":"2.0","method":"eth_syncing","params":[]}' \
  -H 'content-type: application/json' http://127.0.0.1:8547

# and then, from the repo
node scripts/node-check.mjs http://127.0.0.1:8547
```

`node-check` compares the node against the public endpoint. What should change:
`debug_traceCall` available, no rate limiting under a burst, no Cloudflare
challenge, and lower latency. What should not: the archive-state line, for the
reason above.

## Cutover

The node listens on localhost only. Reach it from the app server over the
private link, then put it first in the failover list so the public endpoints
remain as backup:

```bash
ORDO_RPC_URLS=http://<node-private-ip>:8547,https://rpc.mainnet.chain.robinhood.com
```

Nothing needs to change in the services — `rpcFetch` already rotates on
transport errors, so a node that goes down degrades to the public endpoint
instead of taking the stack with it.

## Notes

- Nitro is pinned to `v3.11.2-3599aca`, running ArbOS 61. On an ArbOS upgrade
  an un-upgraded node stops cleanly and resumes after updating, without data
  loss — but it does stop, so watch for the release.
- `--init.download-path` points outside the data directory on purpose. With the
  default staging path, a crashed download leaves files that make Nitro refuse
  to initialise into a "non-empty" data directory on every subsequent start.
- The published pruned snapshot is hash-scheme. Do not add
  `--execution.caching.state-scheme=path`: a node whose state scheme disagrees
  with its snapshot cannot use it, and the failure looks like a corrupt
  download rather than a configuration mistake.
