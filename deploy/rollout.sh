#!/usr/bin/env bash
# Zero-downtime rollout of the gateway.
#
#   bash deploy/rollout.sh              # build, then replace gateway-a and gateway-b one at a time
#   bash deploy/rollout.sh --no-build   # same, reusing the image already built
#   ORDO_ROLLOUT_FORCE=1 bash deploy/rollout.sh --no-build   # roll an .env-only change
#   bash deploy/rollout.sh caddy        # validate + graceful Caddyfile reload only
#
# `docker compose up -d` recreates every container of a service at once, which
# for the one process that fronts rpc.ordofi.network meant a few seconds of
# 502s for anyone mid-transaction on every deploy. The gateway is therefore two
# named services, gateway-a and gateway-b, and this script replaces them one at
# a time: confirm the other replica is healthy, recreate this one (compose
# sends SIGTERM; the gateway answers /health with 503 while Caddy's active
# check — every 2 s — takes it out of rotation, then drains and exits), wait
# until the new container answers /health, move on. Caddy never sends a
# request to a replica that is about to close.
#
# Run from the repo root on the host. Idempotent: replicas already on the
# current image are left alone unless ORDO_ROLLOUT_FORCE=1. Always finishes
# with a Caddyfile validate + reload, which is graceful and a no-op when the
# file has not changed.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.prod.yml)
# An optional override file (staging ports, a different Caddyfile) layered on top.
[ -n "${ORDO_COMPOSE_EXTRA:-}" ] && COMPOSE+=(-f "$ORDO_COMPOSE_EXTRA")
REPLICAS=(gateway-a gateway-b)
HEALTH_TIMEOUT="${ORDO_ROLLOUT_HEALTH_TIMEOUT:-60}"

say() { printf '  %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

caddy_reload() {
  if ! "${COMPOSE[@]}" ps --status running -q caddy 2>/dev/null | grep -q .; then
    say "--    caddy is not running; skipping reload"
    return 0
  fi
  "${COMPOSE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || die "Caddyfile does not validate; nothing reloaded"
  "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
  say "ok    caddy reloaded"
}

if [ "${1:-}" = "caddy" ]; then
  caddy_reload
  exit 0
fi

container_of() { "${COMPOSE[@]}" ps --status running -q "$1" 2>/dev/null | head -n1; }

# The container answers on its own loopback; asking it there avoids caring
# which Docker network it landed on.
healthy() {
  local id="$1"
  [ -n "$id" ] || return 1
  docker exec "$id" node -e '
    fetch("http://127.0.0.1:8547/health").then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))
  ' >/dev/null 2>&1
}

wait_healthy() {
  local svc="$1" id
  for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    id="$(container_of "$svc")"
    if healthy "$id"; then
      say "ok    $svc healthy"
      return 0
    fi
    sleep 1
  done
  say "!!    $svc did not become healthy in ${HEALTH_TIMEOUT}s; its logs:"
  [ -n "${id:-}" ] && docker logs --tail 40 "$id" 2>&1 | sed 's/^/        /'
  return 1
}

if [ "${1:-}" != "--no-build" ]; then
  say "--    building the gateway image"
  "${COMPOSE[@]}" build "${REPLICAS[0]}"
fi

# No node or jq on the host: the image name comes from `config --images`
# (which also lists dependencies' images, hence the filter) and the project
# name from the label on any running container of this stack.
IMAGE_REF="$("${COMPOSE[@]}" config --images "${REPLICAS[0]}" 2>/dev/null | grep -E '(^|[-_/])gateway(:|$)' | head -n1 || true)"
IMAGE_NEW="$([ -n "$IMAGE_REF" ] && docker image inspect -f '{{.Id}}' "$IMAGE_REF" 2>/dev/null || true)"
any="$("${COMPOSE[@]}" ps -q 2>/dev/null | head -n1 || true)"
if [ -n "$any" ]; then
  PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$any")"
else
  PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$(dirname "$(realpath deploy/docker-compose.prod.yml)")")}"
fi
# Containers of the pre-replica layout (service `gateway`), which compose no
# longer knows by name.
legacy_ids() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=gateway"
}

for svc in "${REPLICAS[@]}"; do
  id="$(container_of "$svc")"
  if [ -n "$id" ] && [ "${ORDO_ROLLOUT_FORCE:-0}" != "1" ] && [ -n "$IMAGE_NEW" ] \
     && [ "$(docker inspect -f '{{.Image}}' "$id")" = "$IMAGE_NEW" ] && healthy "$id"; then
    say "ok    $svc already on the current image"
    continue
  fi

  # Never take a replica down unless another one is answering. The legacy
  # single `gateway` service counts, so the first migration is also seamless.
  other_ok=0
  for o in "${REPLICAS[@]}"; do
    [ "$o" = "$svc" ] && continue
    healthy "$(container_of "$o")" && other_ok=1
  done
  for legacy in $(legacy_ids); do healthy "$legacy" && other_ok=1; done
  if [ "$other_ok" -ne 1 ] && [ -n "$id" ]; then
    die "no other healthy replica; refusing to take $svc down (start the other one first: ${COMPOSE[*]} up -d --no-deps <other>)"
  fi

  say "--    replacing $svc"
  "${COMPOSE[@]}" up -d --no-deps --no-build "$svc" >/tmp/ordo-rollout-up.log 2>&1 \
    || { sed 's/^/        /' /tmp/ordo-rollout-up.log >&2; die "compose could not start $svc"; }
  wait_healthy "$svc" || die "rollout aborted at $svc; the other replica is still serving"
done

# First rollout from the single-service layout: gateway-a/b are up and Caddy
# is about to point at them; the old `gateway` container can go once it does.
caddy_reload
legacy="$(legacy_ids)"
if [ -n "$legacy" ]; then
  say "--    retiring the legacy single gateway container"
  # Caddy already stopped routing to it on reload (graceful: in-flight requests finish).
  sleep 3
  docker stop $legacy >/dev/null && docker rm $legacy >/dev/null
  say "ok    legacy gateway retired"
fi

say "ok    rollout complete"
"${COMPOSE[@]}" ps "${REPLICAS[@]}"
