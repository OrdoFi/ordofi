#!/usr/bin/env bash
# Our own Nitro node as the first RPC upstream — promoted when it is at the
# head, demoted the moment it is not.
#
#   bash deploy/node-rpc.sh status    # sync state, lag against the public head, what .env says
#   bash deploy/node-rpc.sh promote   # node first in every upstream list, then roll the stack
#   bash deploy/node-rpc.sh demote    # public providers first again, then roll the stack
#   bash deploy/node-rpc.sh auto      # what the systemd timer runs every few minutes:
#                                     #   not promoted + healthy N times in a row  -> promote
#                                     #   promoted + lagging/unreachable N times   -> demote
#
# The node is reached over the WireGuard link (10.77.0.2, see
# /etc/wireguard/wg0.conf on both hosts). Every list keeps the public
# providers after the node, so a node that is restarting is a slower minute,
# not an outage: the gateway rotates on the first refused call and hedges slow
# ones. "auto" writes one line per run to $LOG so the history is readable.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env"
NODE="${ORDO_NODE_RPC:-http://10.77.0.2:8547}"
PUBLIC="https://rpc.mainnet.chain.robinhood.com"
STATE_DIR="/var/lib/ordofi"; STATE="$STATE_DIR/node-rpc.state"
LOG="/var/log/ordofi-node-rpc.log"
# How many consecutive healthy checks promote, how many bad ones demote, and
# how far behind the public head counts as lagging. Three checks five minutes
# apart is fifteen minutes of evidence either way.
PROMOTE_AFTER=3; DEMOTE_AFTER=3; MAX_LAG=20
COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.prod.yml)

say() { printf '  %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { mkdir -p "$(dirname "$LOG")"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

rpc() { # rpc <url> <method> -> result field, or empty on any failure
  curl -s -m 8 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "$1" 2>/dev/null \
    | python3 -c 'import json,sys
try: print(json.dumps(json.load(sys.stdin).get("result")))
except Exception: print("")' 2>/dev/null || true
}
hexnum() { python3 -c 'import sys,json; v=json.loads(sys.argv[1]); print(int(v,16) if isinstance(v,str) else -1)' "$1" 2>/dev/null || echo -1; }

# ---- what the node and the chain say ---------------------------------------
NODE_HEAD=-1; PUBLIC_HEAD=-1; SYNCING="unreachable"; LAG=-1; HEALTHY=0
probe() {
  local s h p
  s="$(rpc "$NODE" eth_syncing)"; h="$(rpc "$NODE" eth_blockNumber)"; p="$(rpc "$PUBLIC" eth_blockNumber)"
  [ -n "$h" ] && [ "$h" != "null" ] && NODE_HEAD="$(hexnum "$h")"
  [ -n "$p" ] && [ "$p" != "null" ] && PUBLIC_HEAD="$(hexnum "$p")"
  if [ -z "$s" ]; then SYNCING="unreachable"
  elif [ "$s" = "false" ]; then SYNCING="no"
  else SYNCING="yes"; fi
  if [ "$NODE_HEAD" -ge 0 ] && [ "$PUBLIC_HEAD" -ge 0 ]; then LAG=$((PUBLIC_HEAD - NODE_HEAD)); fi
  # Healthy: reachable, not reporting a sync, and within MAX_LAG of the public
  # head (the public head itself may be a block or two ahead or behind us).
  if [ "$SYNCING" = "no" ] && [ "$LAG" -ge -50 ] && [ "$LAG" -le "$MAX_LAG" ]; then HEALTHY=1; fi
}

# ---- .env surgery -----------------------------------------------------------
env_get() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true; }
env_set() { # env_set KEY VALUE — replace the line or append it
  if grep -qE "^$1=" "$ENV_FILE"; then
    python3 - "$ENV_FILE" "$1" "$2" <<'EOF'
import sys,re
f,k,v=sys.argv[1:]; s=open(f).read()
s=re.sub(r'^'+re.escape(k)+r'=.*$', lambda m: k+'='+v, s, count=1, flags=re.M)
open(f,'w').write(s)
EOF
  else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
without_node() { # drop the node from a comma list, keep order
  printf '%s' "$1" | tr ',' '\n' | grep -vxF "$NODE" | grep -v '^$' | paste -sd, - || true
}
is_promoted() { [ "$(env_get ORDO_RPC_URLS_LIGHT | cut -d, -f1)" = "$NODE" ]; }

roll() {
  say "rolling the gateway (env-only change)"
  ORDO_ROLLOUT_FORCE=1 bash deploy/rollout.sh --no-build | sed 's/^/    /'
  # Everything else re-reads .env on recreate. One at a time; the web pair
  # last and separately so pools pages and the app are never down together.
  for s in watcher auction arb searcher liquidity web; do
    say "recreating $s"; "${COMPOSE[@]}" up -d --no-deps --force-recreate "$s" >/dev/null 2>&1 || say "  ($s not running here, skipped)"
  done
}

promote() {
  probe
  [ "$HEALTHY" = 1 ] || die "node is not ready: syncing=$SYNCING node=$NODE_HEAD public=$PUBLIC_HEAD lag=$LAG"
  is_promoted && { say "already promoted"; return; }
  cp "$ENV_FILE" "$ENV_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  local light bulk archive
  light="$(without_node "$(env_get ORDO_RPC_URLS_LIGHT)")"; bulk="$(without_node "$(env_get ORDO_RPC_URLS)")"; archive="$(without_node "$(env_get ORDO_ARCHIVE_RPC)")"
  env_set ORDO_RPC_URLS_LIGHT "$NODE${light:+,$light}"
  env_set ORDO_RPC_URLS "$NODE${bulk:+,$bulk}"
  # A pruned node keeps every block and receipt, so eth_getLogs history is
  # complete; only historical *state* is gone, which nothing here reads.
  env_set ORDO_ARCHIVE_RPC "$NODE${archive:+,$archive}"
  say "node first in ORDO_RPC_URLS_LIGHT, ORDO_RPC_URLS, ORDO_ARCHIVE_RPC"
  roll; log "PROMOTED node=$NODE_HEAD public=$PUBLIC_HEAD lag=$LAG"
}

demote() {
  is_promoted || { say "not promoted"; return; }
  cp "$ENV_FILE" "$ENV_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  env_set ORDO_RPC_URLS_LIGHT "$(without_node "$(env_get ORDO_RPC_URLS_LIGHT)")"
  env_set ORDO_RPC_URLS "$(without_node "$(env_get ORDO_RPC_URLS)")"
  env_set ORDO_ARCHIVE_RPC "$(without_node "$(env_get ORDO_ARCHIVE_RPC)")"
  say "public providers first again"
  roll; log "DEMOTED reason=${1:-manual} syncing=$SYNCING node=$NODE_HEAD public=$PUBLIC_HEAD lag=$LAG"
}

status() {
  probe
  say "node      $NODE"
  say "syncing   $SYNCING"
  say "head      node=$NODE_HEAD public=$PUBLIC_HEAD lag=$LAG"
  say "healthy   $([ "$HEALTHY" = 1 ] && echo yes || echo no)   (within $MAX_LAG blocks, not syncing)"
  say "promoted  $(is_promoted && echo yes || echo no)"
  [ -f "$STATE" ] && say "auto      $(cat "$STATE")"
  [ -f "$LOG" ] && { say "log       $LOG"; tail -n 3 "$LOG" | sed 's/^/            /'; }
}

auto() {
  mkdir -p "$STATE_DIR"; local ok=0 bad=0
  [ -f "$STATE" ] && { ok="$(sed -n 's/^ok=\([0-9]*\).*/\1/p' "$STATE")"; bad="$(sed -n 's/.*bad=\([0-9]*\).*/\1/p' "$STATE")"; ok="${ok:-0}"; bad="${bad:-0}"; }
  probe
  if is_promoted; then
    if [ "$HEALTHY" = 1 ]; then bad=0; else bad=$((bad + 1)); fi
    log "check promoted=yes syncing=$SYNCING node=$NODE_HEAD public=$PUBLIC_HEAD lag=$LAG bad=$bad/$DEMOTE_AFTER"
    if [ "$bad" -ge "$DEMOTE_AFTER" ]; then demote "auto:lag_or_unreachable"; bad=0; ok=0; fi
  else
    if [ "$HEALTHY" = 1 ]; then ok=$((ok + 1)); else ok=0; fi
    log "check promoted=no syncing=$SYNCING node=$NODE_HEAD public=$PUBLIC_HEAD lag=$LAG ok=$ok/$PROMOTE_AFTER"
    if [ "$ok" -ge "$PROMOTE_AFTER" ]; then promote; ok=0; bad=0; fi
  fi
  printf 'ok=%s bad=%s at=%s\n' "$ok" "$bad" "$(date -u +%FT%TZ)" > "$STATE"
}

case "${1:-status}" in
  status) status ;;
  promote) promote ;;
  demote) demote manual ;;
  auto) auto ;;
  *) die "usage: node-rpc.sh status|promote|demote|auto" ;;
esac
