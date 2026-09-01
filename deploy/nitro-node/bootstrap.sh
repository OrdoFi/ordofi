#!/usr/bin/env bash
# Prepares a fresh Ubuntu host to run the OrdoFi Nitro node: storage, Docker,
# the Robinhood config files, and the current snapshot URL.
#
# It deliberately does NOT start the node. The restore downloads and extracts
# several hundred gigabytes, and starting that by accident — with the wrong
# disk mounted, or no L1 endpoint — wastes hours and someone's bandwidth bill.
#
#   sudo ./bootstrap.sh              # prepare, using an existing /data mount
#   sudo RAID0=yes ./bootstrap.sh    # also claim the free NVMe disks (DESTRUCTIVE)
#
# On Vultr's "No RAID, extra disks unformatted" there is exactly one free disk
# — the OS holds the other — so the second form formats that one and mounts it.
# It only stripes when it finds two or more genuinely unused disks.
set -euo pipefail

INSTALL_DIR=/opt/ordofi-node
DATA=/data

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

log "Installing Docker and tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg mdadm python3 chrony >/dev/null
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
systemctl enable --now docker chrony

# Nitro stalls on a skewed clock in ways that look like a network fault.
timedatectl set-ntp true 2>/dev/null || true

log "Preparing storage at $DATA"
if mountpoint -q "$DATA"; then
  echo "  $DATA already mounted — leaving it alone"
elif [ "${RAID0:-no}" = "yes" ]; then
  # Everything that is an NVMe namespace, is not the root disk, and holds no
  # mounted filesystem. Anything else is not ours to format.
  ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)
  mapfile -t DISKS < <(
    lsblk -dpno NAME,TYPE | awk '$2=="disk" && $1 ~ /nvme/ {print $1}' |
      while read -r d; do
        [ "$(basename "$d")" = "$ROOT_DISK" ] && continue
        lsblk -no MOUNTPOINT "$d" | grep -q . && continue
        echo "$d"
      done
  )
  [ "${#DISKS[@]}" -ge 1 ] || die "no free NVMe disks found; mount your storage at $DATA and rerun"
  echo "  striping: ${DISKS[*]}"
  echo "  THIS ERASES THOSE DISKS. Ctrl-C within 10s to abort."
  sleep 10
  if [ "${#DISKS[@]}" -ge 2 ]; then
    mdadm --create /dev/md0 --level=0 --raid-devices="${#DISKS[@]}" "${DISKS[@]}" --run
    mdadm --detail --scan >> /etc/mdadm/mdadm.conf
    update-initramfs -u
    TARGET=/dev/md0
  else
    TARGET="${DISKS[0]}"
  fi
  mkfs.ext4 -F -m 0 -T largefile4 "$TARGET"
  mkdir -p "$DATA"
  echo "UUID=$(blkid -s UUID -o value "$TARGET") $DATA ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
  mount "$DATA"
else
  die "$DATA is not mounted. Mount your NVMe storage there, or rerun with RAID0=yes to stripe the free disks."
fi

AVAIL_GB=$(df -BG --output=avail "$DATA" | tail -1 | tr -dc '0-9')
echo "  $AVAIL_GB GB available at $DATA"
[ "$AVAIL_GB" -ge 1200 ] || cat <<WARN

  WARNING: $AVAIL_GB GB is below the ~1.2 TB this needs.
  The restore peaks at roughly twice the snapshot size (downloaded parts plus
  the extracted database), and the chain adds ~230 GB a month after that.

WARN

mkdir -p "$INSTALL_DIR/config" "$DATA/arbitrum" "$DATA/init"

log "Downloading Robinhood Chain config"
CDN=https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs
for f in robinhood-chain-info.json robinhood-genesis.json; do
  curl --fail --retry 8 --retry-all-errors -sSL "$CDN/$f" -o "$INSTALL_DIR/config/$f"
  echo "  $f ($(stat -c%s "$INSTALL_DIR/config/$f") bytes)"
done
python3 -c "
import json,sys
info=json.load(open('$INSTALL_DIR/config/robinhood-chain-info.json'))
info=info[0] if isinstance(info,list) else info
assert info['chain-id']==4663, info['chain-id']
print('  chain-id 4663, parent chain', info['parent-chain-id'])
" || die "chain-info.json is not what we expect"

log "Resolving the current pruned snapshot"
SNAP_URL=$(python3 - <<'PY'
import json, urllib.parse, urllib.request
# The explorer 403s the default urllib agent.
api = urllib.request.Request(
    "https://snapshot-explorer.arbitrum.io/api/snapshots",
    headers={"user-agent": "ordofi-node-bootstrap"},
)
data = json.load(urllib.request.urlopen(api, timeout=30))["data"]
chain = next(c for c in data if c["name"] == "Robinhood Chain")
# Pruned is the smallest published kind and the one this node is configured
# for; its hash state scheme has to match the node's.
pruned = [s for s in chain["snapshots"] if s["type"] == "Pruned" and s.get("isFinished")]
latest = max(pruned, key=lambda s: s["snapshotDate"])
# Part keys are relative to the parent of the snapshot directory, so the
# directory URL is the base plus everything up to the last path segment.
directory = latest["parts"][0]["key"].rsplit("/", 1)[0]
base = chain["downloadBaseUrl"].rstrip("/")
print(f"{base}/{urllib.parse.quote(directory)}/")
import sys
size = sum(p["size"] for p in latest["parts"]) / 1e9
print(f"{latest['snapshotDate']} {size:.0f}", file=sys.stderr)
PY
) || die "could not resolve a snapshot URL"
echo "  $SNAP_URL"

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" <<EOF
# Ethereum mainnet endpoints. Robinhood Chain posts its data to L1, so the node
# needs both an execution RPC and a beacon endpoint that serves blobs.
L1_RPC_URL=
L1_BEACON_URL=

NITRO_INIT_URL=$SNAP_URL
NITRO_DATA_DIR=$DATA/arbitrum
NITRO_INIT_DIR=$DATA/init
EOF
  chmod 600 "$INSTALL_DIR/.env"
else
  echo "  keeping existing $INSTALL_DIR/.env"
fi

log "Ready"
cat <<EOF

  1. Put your L1 endpoints in $INSTALL_DIR/.env
       L1_RPC_URL=      execution RPC (Ethereum mainnet)
       L1_BEACON_URL=   beacon/consensus endpoint, must serve blobs

  2. Copy docker-compose.yml next to it, then start the restore:
       cd $INSTALL_DIR && docker compose up -d && docker compose logs -f

     The first run downloads and extracts the snapshot. Expect hours, and
     watch that $DATA does not fill: peak usage is about twice the snapshot.

  3. When it is caught up, eth_syncing returns false:
       curl -s -d '{"id":0,"jsonrpc":"2.0","method":"eth_syncing","params":[]}' \\
         -H 'content-type: application/json' http://127.0.0.1:8547

  4. Prove it is better than the public endpoint:
       node scripts/node-check.mjs http://127.0.0.1:8547

EOF
