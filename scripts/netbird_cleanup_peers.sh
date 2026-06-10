#!/usr/bin/env bash
# netbird_cleanup_peers.sh
# Removes stale NetBird peers that match a cluster's hostname pattern.
#
# Usage:
#   netbird_cleanup_peers.sh <cluster_pattern> [netbird_api_url]
#
# Arguments:
#   cluster_pattern  Grep-compatible pattern to match peer hostnames
#                    Example: "talos-prod" or "talos-ontwikkel"
#   netbird_api_url  Optional. Defaults to https://netbird.example.com
#
# Environment:
#   NETBIRD_API_TOKEN  Required. Personal Access Token for NetBird API.
#                      Format: nbp_<30 chars><6 char checksum>
#
# Exit codes:
#   0  Success (even if 0 peers were deleted)
#   1  Missing NETBIRD_API_TOKEN
#   2  API call failed

set -euo pipefail

CLUSTER_PATTERN="${1:?Usage: $0 <cluster_pattern> [api_url]}"
NETBIRD_API="${2:-https://netbird.example.com}"

if [ -z "${NETBIRD_API_TOKEN:-}" ]; then
  echo "❌ NETBIRD_API_TOKEN is not set" >&2
  exit 1
fi

echo "==> Fetching NetBird peers from ${NETBIRD_API}/api/peers"
PEERS_JSON=$(curl -sf --max-time 30 \
  -H "Authorization: Token ${NETBIRD_API_TOKEN}" \
  -H "Accept: application/json" \
  "${NETBIRD_API}/api/peers" 2>&1) || {
  echo "❌ Failed to fetch peers from NetBird API" >&2
  exit 2
}

# Extract IDs of peers matching the pattern (offline only — never delete connected peers)
MATCHING_PEERS=$(echo "$PEERS_JSON" | python3 -c "
import sys, json
peers = json.load(sys.stdin)
pattern = '${CLUSTER_PATTERN}'.lower()
matched = []
for p in peers:
    hostname = p.get('hostname', '').lower()
    connected = p.get('connected', False)
    if pattern in hostname and not connected:
        matched.append({'id': p['id'], 'hostname': p['hostname'], 'ip': p.get('ip', '?')})
for m in matched:
    print(f\"{m['id']}|{m['hostname']}|{m['ip']}\")
" 2>/dev/null)

if [ -z "$MATCHING_PEERS" ]; then
  echo "✅ No offline peers matching '${CLUSTER_PATTERN}' found — nothing to delete"
  exit 0
fi

echo "==> Found peers to remove:"
echo "$MATCHING_PEERS" | while IFS='|' read -r peer_id hostname ip; do
  echo "    ${hostname} (${ip}) [${peer_id}]"
done

DELETED=0
FAILED=0
echo "$MATCHING_PEERS" | while IFS='|' read -r peer_id hostname _ip; do
  result=$(curl -sf --max-time 15 -X DELETE \
    -H "Authorization: Token ${NETBIRD_API_TOKEN}" \
    "${NETBIRD_API}/api/peers/${peer_id}" 2>&1) && {
    echo "    ✓ Deleted ${hostname} [${peer_id}]"
    DELETED=$((DELETED + 1))
  } || {
    echo "    ⚠ Failed to delete ${hostname} [${peer_id}]: ${result}" >&2
    FAILED=$((FAILED + 1))
  }
done

echo "==> NetBird peer cleanup complete for pattern '${CLUSTER_PATTERN}'"
