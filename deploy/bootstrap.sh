#!/usr/bin/env bash
# OrdoFi server bootstrap — Ubuntu 24.04, run as root on a fresh host.
#
#   curl -fsSL https://raw.githubusercontent.com/OrdoFi/ordofi/main/deploy/bootstrap.sh | bash
#
# or, with the repo already on the box:
#
#   bash deploy/bootstrap.sh
#
# Installs Docker, writes .env by asking for the few things it cannot know,
# and brings the stack up behind Caddy. Safe to re-run: it skips whatever is
# already done and leaves an existing .env alone unless told otherwise.
set -euo pipefail

REPO="${ORDO_REPO:-https://github.com/OrdoFi/ordofi.git}"
DIR="${ORDO_DIR:-/opt/ordofi}"

# Deployed on Robinhood Chain. Overridable, but these are the live ones.
SETTLEMENT="${ORDO_SETTLEMENT_ADDRESS:-0xbC680922DaF2F65a8B957e5238857f8c68BeDabb}"
BUNDLER="${ORDO_BUNDLER_ADDRESS:-0xc0bccFb3aA4ad9160d272645376a1797a32f3c4a}"

hr() { printf '%s\n' "----------------------------------------------------------------"; }
say() { printf '  %s\n' "$1"; }
die() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash deploy/bootstrap.sh)"

hr
echo "OrdoFi server bootstrap"
hr

# --- Docker -------------------------------------------------------------------

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  say "ok    docker present ($(docker --version | cut -d' ' -f3 | tr -d ,))"
else
  say "--    installing docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  say "ok    docker installed"
fi

# --- Firewall -----------------------------------------------------------------
#
# Caddy cannot obtain a certificate if port 80 is closed, and that failure looks
# like a DNS problem in the logs, so open it before anything starts.

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  say "ok    ufw allows 80 and 443"
else
  say "--    ufw inactive; make sure the provider firewall allows 80 and 443"
fi

# --- Source -------------------------------------------------------------------

if [ -d "$DIR/.git" ]; then
  say "ok    repo present at $DIR"
  git -C "$DIR" pull --ff-only >/dev/null 2>&1 && say "ok    pulled latest" \
    || say "--    could not fast-forward; leaving the working tree as it is"
elif [ -f "$(dirname "$0")/../package.json" ]; then
  DIR="$(cd "$(dirname "$0")/.." && pwd)"
  say "ok    running from an existing checkout at $DIR"
else
  say "--    cloning $REPO -> $DIR"
  git clone --depth 1 "$REPO" "$DIR" || die "clone failed — private repo? add a deploy key, or set ORDO_REPO"
fi

cd "$DIR"

# --- Configuration ------------------------------------------------------------

if [ -f .env ]; then
  hr
  say "an .env already exists; leaving it untouched"
  say "delete it and re-run if you want to reconfigure"
else
  hr
  echo "Configuration"
  echo
  echo "The auctioneer key signs settle() on-chain. It is written to $DIR/.env"
  echo "and read by the auction container. Paste the private key for the"
  echo "auctioneer address, or leave it blank to run without on-chain"
  echo "settlement for now (rebates become accounting that collects nothing)."
  echo
  read -r -s -p "  auctioneer private key (hidden, optional): " AUCT_KEY
  echo

  API_KEY="ordo_$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  umask 077
  cat > .env <<EOF
# Written by deploy/bootstrap.sh. Contains a private key — keep 0600.
ORDO_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ORDO_FEED_URL=wss://feed.mainnet.chain.robinhood.com

ORDO_SETTLEMENT_ADDRESS=$SETTLEMENT
ORDO_BUNDLER_ADDRESS=$BUNDLER
ORDO_AUCTIONEER_KEY=$AUCT_KEY

# key:label:rateLimitPerMin:rebateAddress:mode
ORDO_API_KEYS=$API_KEY:first-app:600::auction
ORDO_ALLOW_ANON=1

ORDO_AUCTION_WINDOW_MS=200
ORDO_HINT_LEVEL=pools
ORDO_REBATE_USER=0.9
ORDO_REBATE_APP=0.05
ORDO_REBATE_PROTOCOL=0.05
EOF
  chmod 600 .env
  say "ok    wrote $DIR/.env (0600)"
  say "ok    minted api key: $API_KEY"
fi

# --- Up -----------------------------------------------------------------------

hr
say "building and starting (first build takes a few minutes)..."
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build

hr
docker compose --env-file .env -f deploy/docker-compose.prod.yml ps
hr
echo "Next:"
echo "  DNS must already point app/rpc/auction.ordofi.network at this host, or"
echo "  Caddy will keep failing to get certificates. Watch it with:"
echo
echo "    docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f caddy"
echo
echo "  Then check:  curl https://app.ordofi.network/api/stats"
hr
