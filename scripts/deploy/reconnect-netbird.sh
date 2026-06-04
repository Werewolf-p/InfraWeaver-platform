#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/reconnect-netbird.sh — Reconnect NetBird router VM after cluster redeploy
#
# Usage: ENV_NAME=productie bash scripts/deploy/reconnect-netbird.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${ENV_NAME:?Usage: ENV_NAME=productie bash $0}"
# After full redeploy the NetBird SQLite DB is wiped — old peer keys are rejected.
# The router VM (10.10.0.10) has a systemd watchdog that auto-reconnects every 60s,
# but this step forces immediate reconnect to avoid the 60s delay.
#
# NOTE: Runs after MetalLB so METALLB_NETBIRD_MGMT_VIP is reachable.
# Router: netbird-router-vlan3, 10.10.0.10 (VLAN3), ubuntu user
# Setup key: static A1B2C3D4-E5F6-7890-ABCD-EF1234567890 (hardcoded in bootstrap-job.yaml)
# Management: http://${METALLB_NETBIRD_MGMT_VIP} (internal MetalLB VIP — avoids gRPC issues via Traefik)
# CI runner is also on VLAN3 (10.10.0.108) — no proxy jump needed.
ROUTER_IP="10.10.0.10"
ROUTER_USER="ubuntu"
SETUP_KEY="A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
MGMT_URL="https://netbird.rlservers.com"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -i ~/.ssh/deployer_ed25519"

echo "==> Checking SSH connectivity to router VM at $ROUTER_IP..."
if ! ssh $SSH_OPTS "$ROUTER_USER@$ROUTER_IP" "echo OK" 2>/dev/null; then
  echo "⚠️  Cannot reach router VM via SSH at $ROUTER_IP — watchdog will reconnect automatically within 60s"
  exit 0
fi
echo "  ✅ Router VM reachable"

echo "==> Forcing NetBird reconnect on router VM..."
# timeout 90 on the SSH session itself prevents hanging if netbird up blocks
timeout 90 ssh $SSH_OPTS "$ROUTER_USER@$ROUTER_IP" "
  sudo netbird down 2>/dev/null || true
  sudo systemctl stop netbird 2>/dev/null || true
  sudo rm -rf /var/lib/netbird/state.json /var/lib/netbird/management.json 2>/dev/null || true
  sudo systemctl start netbird
  sleep 2
  # Run netbird up in background (it may block waiting for management connection)
  sudo netbird up \
    --management-url '$MGMT_URL' \
    --setup-key '$SETUP_KEY' \
    --interface-name wt0 2>&1 &
  sleep 5
  echo '--- Waiting for Connected status (max 45s) ---'
  for i in \$(seq 1 9); do
    STATUS=\$(sudo netbird status 2>/dev/null | grep -i 'Management:' | head -1 || echo '')
    echo \"  [\$i/9] \$STATUS\"
    echo \"\$STATUS\" | grep -qi 'Connected' && echo '✅ Router connected to management!' && break
    sleep 5
  done
  sudo netbird status 2>/dev/null | grep -E 'Management:|NetBird IP:|Peers' | head -5 || true
" 2>&1 || echo "⚠️  Router SSH command returned error — watchdog will handle reconnect"
echo "✅ Router reconnect step complete"

