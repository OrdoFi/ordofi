#!/usr/bin/env bash
# The hidden preview of the liquidity pages (Pools, Stakes, Positions) on the
# app server: same image and data volume as production, ORDO_POOLS_ENABLED=1,
# bound to 127.0.0.1:3005 only. Reach it through an SSH tunnel:
#
#   ssh -N -L 3005:127.0.0.1:3005 ordofi
#
# Run from the repo root on the server after pulling:
#
#   deploy/preview.sh            # rebuild the web image, recreate the preview
#   deploy/preview.sh --no-build # recreate from the current image
#
# The inspector listens inside the container on 9229 (not published), so a
# CPU profile can be taken with `docker exec web-preview node /tmp/prof.mjs`.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env in $(pwd)"; exit 1; }

if [ "${1:-}" != "--no-build" ]; then
  docker compose --env-file .env -f deploy/docker-compose.prod.yml build web
fi

set -a; . ./.env; set +a
docker rm -f web-preview >/dev/null 2>&1 || true
docker run -d --name web-preview --restart unless-stopped --network deploy_default \
  -p 127.0.0.1:3005:3000 -v deploy_ordo-data:/app/data \
  -e SERVICE=web -e ORDO_WEB_PORT=3000 -e ORDO_POOLS_ENABLED=1 \
  -e ORDO_RPC_URL="${ORDO_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}" \
  -e ORDO_RPC_URLS="${ORDO_RPC_URLS_LIGHT:-${ORDO_RPC_URLS:-}}" \
  -e ORDO_ARCHIVE_RPC="${ORDO_ARCHIVE_RPC:-}" \
  -e ORDO_AUCTION_URL=http://auction:8548 -e ORDO_ARB_URL=http://arb:8549 \
  -e ORDO_SETTLEMENT_ADDRESS="${ORDO_SETTLEMENT_ADDRESS:-}" \
  -e ORDO_STEALTH_SEND_ADDRESS="${ORDO_STEALTH_SEND_ADDRESS:-}" \
  -e ORDO_LADDER_ADDRESS="${ORDO_LADDER_ADDRESS:-}" -e ORDO_LADDER_BLOCK="${ORDO_LADDER_BLOCK:-}" \
  -e ORDO_STAKE_FACTORY="${ORDO_STAKE_FACTORY:-}" -e ORDO_STAKE_ZAP="${ORDO_STAKE_ZAP:-}" \
  -w /app/apps/web \
  deploy-web node --inspect=127.0.0.1:9229 serve.mjs >/dev/null
sleep 4
curl -s -o /dev/null -w "preview http://127.0.0.1:3005/pools -> %{http_code}\n" http://127.0.0.1:3005/pools
