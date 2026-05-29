#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/populate-netbird.sh — Populate NetBird routing groups and policies after reconnect
#
# Usage: ENV_NAME=productie bash scripts/deploy/populate-netbird.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
# The ArgoCD PostSync bootstrap job runs at apps-netbird sync time, before MetalLB
# and before the router reconnects — so it finds 0 peers. This step runs AFTER
# the router reconnect to populate the routing group via the NetBird API.
KB=~/.kube/config-platform-${ENV_NAME:?ENV_NAME required}
KT="kubectl --kubeconfig $KB --insecure-skip-tls-verify"

echo "==> Port-forwarding NetBird management API..."
kubectl --kubeconfig $KB port-forward svc/netbird-management -n netbird 8086:80 \
  > /tmp/nb-pf-routing.log 2>&1 &
PF_PID=$!
sleep 5

PAT=$(kubectl --kubeconfig $KB get secret netbird-secrets -n netbird \
  -o jsonpath='{.data.netbird-pat-token}' 2>/dev/null | base64 -d)

echo "==> Waiting up to 90s for router peer to connect..."
for i in $(seq 1 18); do
  CONNECTED=$(curl -s -H "Authorization: Token $PAT" \
    http://localhost:8086/api/peers 2>/dev/null | \
    python3 -c "import json,sys; peers=json.load(sys.stdin); print(' '.join(p['id'] for p in peers if p.get('connected')))" 2>/dev/null || echo "")
  if [ -n "$CONNECTED" ]; then
    echo "  ✅ Connected peer(s) found: $CONNECTED"
    break
  fi
  echo "  [$i/18] No connected peers yet..."
  sleep 5
done

if [ -z "$CONNECTED" ]; then
  echo "⚠️  No connected peers after 90s — routing group will be empty"
  kill $PF_PID 2>/dev/null || true
  exit 0
fi

# Add all connected peers to routing-peers-vlan3
GRP_ID=$(curl -s -H "Authorization: Token $PAT" \
  http://localhost:8086/api/groups 2>/dev/null | \
  python3 -c "import json,sys; grps=json.load(sys.stdin); print(next((g['id'] for g in grps if g['name']=='routing-peers-vlan3'),''))" 2>/dev/null)

if [ -z "$GRP_ID" ]; then
  echo "⚠️  routing-peers-vlan3 group not found"
  kill $PF_PID 2>/dev/null || true
  exit 0
fi

PEER_IDS_JSON=$(echo "$CONNECTED" | python3 -c "import sys; ids=sys.stdin.read().split(); print('[' + ','.join('\"'+i+'\"' for i in ids) + ']')")
RESULT=$(curl -s -X PUT \
  -H "Authorization: Token $PAT" \
  -H "Content-Type: application/json" \
  "http://localhost:8086/api/groups/$GRP_ID" \
  -d "{\"name\":\"routing-peers-vlan3\",\"peers\":$PEER_IDS_JSON}" 2>/dev/null)
PEER_NAMES=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print([p.get('name','?') for p in d.get('peers',[])])" 2>/dev/null || echo "error")
echo "✅ routing-peers-vlan3 now contains: $PEER_NAMES"

kill $PF_PID 2>/dev/null || true

