#!/usr/bin/env bash
# OrdoFi mainnet deploy — settlement contract and atomic bundle factory.
#
# One-time setup:
#
#   cast wallet import ordo-deployer --interactive
#     (paste the deployer private key, set a password; stored encrypted under
#      ~/.foundry/keystores/ordo-deployer — never on the command line)
#
# Then fund the printed deployer address on Robinhood Chain and run:
#
#   AUCTIONEER=0x... TREASURY=0x... ./deploy.sh
#
# The script refuses to broadcast unless the preflight passes, simulates the
# whole deployment against real mainnet state first, and writes the resulting
# addresses to ../.env.deployed for the services to pick up.
set -euo pipefail

: "${AUCTIONEER:?set AUCTIONEER (address authorized to submit settlements)}"
: "${TREASURY:?set TREASURY (protocol fee recipient)}"
APP_BPS="${APP_BPS:-500}"
PROTOCOL_BPS="${PROTOCOL_BPS:-500}"
ACCOUNT="${ACCOUNT:-ordo-deployer}"
RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
OUT="${OUT:-$(cd "$(dirname "$0")/.." && pwd)/.env.deployed}"

hr() { printf '%s\n' "----------------------------------------------------------------"; }

hr
echo "OrdoFi deploy -> Robinhood Chain (4663)"
echo "  auctioneer : $AUCTIONEER"
echo "  treasury   : $TREASURY"
echo "  split      : app=${APP_BPS}bps protocol=${PROTOCOL_BPS}bps user=$((10000 - APP_BPS - PROTOCOL_BPS))bps"
echo "  keystore   : $ACCOUNT"
echo "  rpc        : $RPC"
hr

# --- preflight ---------------------------------------------------------------

fail=0
note() { echo "  FAIL  $1"; fail=1; }
pass() { echo "  ok    $1"; }

CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo "")
[ "$CHAIN" = "4663" ] && pass "rpc reachable, chain id 4663" || note "rpc unreachable or wrong chain (got '${CHAIN:-none}')"

for addr in "$AUCTIONEER" "$TREASURY"; do
  case "$addr" in
    0x[0-9a-fA-F][0-9a-fA-F]*) [ ${#addr} -eq 42 ] && pass "address well formed: $addr" || note "not a 20-byte address: $addr" ;;
    *) note "not an address: $addr" ;;
  esac
done

if [ $((APP_BPS + PROTOCOL_BPS)) -ge 10000 ]; then
  note "app+protocol bps must leave something for the user"
else
  pass "split leaves $((10000 - APP_BPS - PROTOCOL_BPS))bps to users"
fi

KEYSTORE="${KEYSTORE:-$HOME/.foundry/keystores/$ACCOUNT}"
if [ -f "$KEYSTORE" ]; then
  pass "keystore '$ACCOUNT' found"
else
  note "no keystore '$ACCOUNT' at $KEYSTORE — run: cast wallet import $ACCOUNT --interactive"
  echo "  --    keystores available: $(cast wallet list 2>/dev/null | awk '{print $1}' | paste -sd, -)"
fi

hr
if [ "$fail" -ne 0 ]; then
  echo "preflight failed; nothing was broadcast."
  exit 1
fi

# A Foundry keystore stores no plaintext address, so the deployer's balance
# cannot be checked without unlocking it. Everything checkable for free has
# been checked above, so this is the first and only password prompt — unless
# DEPLOYER_ADDRESS is supplied, in which case the balance check is free too.
if [ -z "${DEPLOYER_ADDRESS:-}" ]; then
  echo "unlocking keystore '$ACCOUNT' to read the deployer address..."
  DEPLOYER=$(cast wallet address --account "$ACCOUNT")
else
  DEPLOYER="$DEPLOYER_ADDRESS"
fi

BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)
echo "  --    deployer $DEPLOYER holds $(cast from-wei "$BAL") ETH"
if [ "$BAL" = "0" ]; then
  echo "  FAIL  deployer has no ETH — fund $DEPLOYER on Robinhood Chain first"
  echo "        (both contracts together cost well under a dollar)"
  exit 1
fi
pass "deployer funded"

# --- simulate against real state, then broadcast ------------------------------

echo "simulating against mainnet state (no broadcast)..."
forge script script/Deploy.s.sol \
  --rpc-url "$RPC" \
  --account "$ACCOUNT" \
  --sig "run(address,address,uint16,uint16)" \
  "$AUCTIONEER" "$TREASURY" "$APP_BPS" "$PROTOCOL_BPS" >/dev/null
echo "  ok    simulation clean"

hr
read -r -p "broadcast to mainnet? [y/N] " reply
case "$reply" in [yY]*) ;; *) echo "aborted."; exit 1 ;; esac

forge script script/Deploy.s.sol \
  --rpc-url "$RPC" \
  --account "$ACCOUNT" \
  --broadcast \
  --sig "run(address,address,uint16,uint16)" \
  "$AUCTIONEER" "$TREASURY" "$APP_BPS" "$PROTOCOL_BPS"

# --- record the addresses -----------------------------------------------------

RUN="broadcast/Deploy.s.sol/4663/run-latest.json"
SETTLEMENT=$(python3 -c "
import json;d=json.load(open('$RUN'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='OrdoSettlement'))")
BUNDLER=$(python3 -c "
import json;d=json.load(open('$RUN'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='OrdoBundler'))")

# Read the addresses back off chain rather than trusting the broadcast report:
# a receipt says what was sent, bytecode says what exists.
for pair in "OrdoSettlement:$SETTLEMENT" "OrdoBundler:$BUNDLER"; do
  name="${pair%%:*}"; addr="${pair##*:}"
  code=$(cast code "$addr" --rpc-url "$RPC")
  [ "$code" = "0x" ] && { echo "ERROR: no bytecode at $name $addr"; exit 1; }
  echo "  verified $name has ${#code} bytes of code at $addr"
done

cat > "$OUT" <<EOF
# Written by contracts/deploy.sh — load these into the auction, gateway and web.
ORDO_SETTLEMENT_ADDRESS=$SETTLEMENT
ORDO_BUNDLER_ADDRESS=$BUNDLER
EOF

hr
cat "$OUT"
hr
echo "Next:"
echo "  1. cat $OUT >> .env"
echo "  2. set ORDO_AUCTIONEER_KEY to the key for $AUCTIONEER"
echo "  3. restart the auction and gateway; both log their on/off state at boot"
