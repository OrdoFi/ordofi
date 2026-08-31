#!/usr/bin/env bash
# OrdoFi settlement contract — secure mainnet deploy.
#
# Uses a Foundry encrypted keystore so your private key is NEVER passed on the
# command line or stored in plaintext. One-time setup:
#
#   cast wallet import ordo-deployer --interactive
#     (paste your deployer private key + set a password; stored encrypted in
#      ~/.foundry/keystores/ordo-deployer)
#
# Fund the deployer address with a little ETH on Robinhood Chain (deploy costs
# well under $1). Then run:
#
#   AUCTIONEER=0x... TREASURY=0x... ./deploy.sh
#
set -euo pipefail

: "${AUCTIONEER:?set AUCTIONEER (address authorized to submit settlements)}"
: "${TREASURY:?set TREASURY (protocol fee recipient)}"
APP_BPS="${APP_BPS:-500}"
PROTOCOL_BPS="${PROTOCOL_BPS:-500}"
ACCOUNT="${ACCOUNT:-ordo-deployer}"
RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"

echo "Deploying OrdoSettlement to Robinhood Chain"
echo "  auctioneer : $AUCTIONEER"
echo "  treasury   : $TREASURY"
echo "  split      : app=${APP_BPS}bps protocol=${PROTOCOL_BPS}bps user=$((10000-APP_BPS-PROTOCOL_BPS))bps"
echo "  keystore   : $ACCOUNT"
echo

DEPLOYER=$(cast wallet address --account "$ACCOUNT")
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "deployer $DEPLOYER balance: $(cast from-wei "$BAL") ETH"
if [ "$BAL" = "0" ]; then
  echo "ERROR: deployer has no ETH on Robinhood Chain. Fund $DEPLOYER first."
  exit 1
fi

forge script script/Deploy.s.sol \
  --rpc-url "$RPC" \
  --account "$ACCOUNT" \
  --broadcast \
  --sig "run(address,address,uint16,uint16)" \
  "$AUCTIONEER" "$TREASURY" "$APP_BPS" "$PROTOCOL_BPS"

echo
echo "Done. Set ORDO_SETTLEMENT_ADDRESS to the deployed address (printed above)"
echo "in your .env and restart the auction + web services."
