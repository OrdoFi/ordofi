#!/usr/bin/env bash
# Deploy OrdoBatch (contracts/src/OrdoBatch.sol) to Robinhood Chain.
#
#   SOLVER=0x... TREASURY=0x... ./deploy-batch.sh
#
# SOLVER is the address of the batcher's hot key (ORDO_BATCH_SOLVER_KEY); make
# one with `cast wallet new` and fund it with a little ETH for gas. TREASURY
# receives the fee. The deployer keystore is `ordo-deployer` (cast wallet
# import), the same one that deployed the other contracts. Prints the address
# and appends ORDO_BATCH_ADDRESS to ../.env.deployed.
set -euo pipefail

: "${SOLVER:?set SOLVER (address of the batcher hot key)}"
: "${TREASURY:?set TREASURY (fee recipient)}"
ACCOUNT="${ACCOUNT:-ordo-deployer}"
RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
MAX_FEE_BPS="${MAX_FEE_BPS:-30}"
OUT="${OUT:-$(cd "$(dirname "$0")/.." && pwd)/.env.deployed}"

WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
ROUTER=0xCaf681a66D020601342297493863E78C959E5cb2
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951

cd "$(dirname "$0")"
DEPLOYER=$(cast wallet address --account "$ACCOUNT")
CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "4663" ] || { echo "rpc is chain $CHAIN, not Robinhood (4663)"; exit 1; }

echo "----------------------------------------------------------------"
echo "OrdoBatch -> Robinhood Chain (4663)"
echo "  deployer/owner : $DEPLOYER  ($(cast balance --ether "$DEPLOYER" --rpc-url "$RPC") ETH)"
echo "  solver         : $SOLVER    ($(cast balance --ether "$SOLVER" --rpc-url "$RPC") ETH)"
echo "  treasury       : $TREASURY"
echo "  max fee        : ${MAX_FEE_BPS} bps"
echo "----------------------------------------------------------------"

forge build --contracts src/OrdoBatch.sol >/dev/null

ADDR=$(forge create src/OrdoBatch.sol:OrdoBatch \
  --rpc-url "$RPC" --account "$ACCOUNT" --broadcast \
  --constructor-args "$WETH" "$ROUTER" "$POOL_MANAGER" "$DEPLOYER" "$SOLVER" "$TREASURY" "$MAX_FEE_BPS" \
  | awk '/Deployed to:/ {print $3}')

[ -n "$ADDR" ] || { echo "deploy failed"; exit 1; }
echo "OrdoBatch deployed: $ADDR"
echo "  solver on-chain : $(cast call "$ADDR" 'solver()(address)' --rpc-url "$RPC")"
echo "  maxFeeBps       : $(cast call "$ADDR" 'maxFeeBps()(uint16)' --rpc-url "$RPC")"
echo "ORDO_BATCH_ADDRESS=$ADDR" >> "$OUT"
echo "wrote ORDO_BATCH_ADDRESS to $OUT"
