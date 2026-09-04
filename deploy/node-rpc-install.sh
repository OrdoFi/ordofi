#!/usr/bin/env bash
# Install the node-rpc timer on the app server. Run from the repo root as root.
set -euo pipefail
cd "$(dirname "$0")/.."
chmod +x deploy/node-rpc.sh
install -m 0644 deploy/systemd/ordofi-node-rpc.service /etc/systemd/system/
install -m 0644 deploy/systemd/ordofi-node-rpc.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ordofi-node-rpc.timer
systemctl list-timers ordofi-node-rpc.timer --no-pager | head -3
