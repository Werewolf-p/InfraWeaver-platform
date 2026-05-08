#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/ensure-cloudflare-dns.sh — Ensure Cloudflare DNS records exist for platform endpoints
#
# Usage: ENV_NAME=productie bash scripts/deploy/ensure-cloudflare-dns.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${ENV_NAME:?Usage: ENV_NAME=productie bash $0}"
if [ -z "$CF_TOKEN" ]; then
  echo "⚠ CLOUDFLARE_API_TOKEN not set — skipping DNS record check"
  exit 0
fi
CF_ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=rlservers.com" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')" 2>/dev/null)
if [ -z "$CF_ZONE_ID" ]; then
  echo "⚠ Could not find rlservers.com zone — skipping"
  exit 0
fi
# Delete old api.netbird.rlservers.com record if it exists
OLD_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=A&name=api.netbird.rlservers.com" \
  -H "Authorization: Bearer $CF_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')" 2>/dev/null)
if [ -n "$OLD_ID" ]; then
  curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${OLD_ID}" \
    -H "Authorization: Bearer $CF_TOKEN" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('Deleted: api.netbird.rlservers.com' if d.get('success') else 'Delete error: ' + str(d.get('errors','')))"
fi
# Delete argocd.rlservers.com public DNS record (ArgoCD is now VPN-only at argocd.int.rlservers.com)
ARGOCD_PUB_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=argocd.rlservers.com" \
  -H "Authorization: Bearer $CF_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')" 2>/dev/null)
if [ -n "$ARGOCD_PUB_ID" ]; then
  curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${ARGOCD_PUB_ID}" \
    -H "Authorization: Bearer $CF_TOKEN" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('Deleted: argocd.rlservers.com (moved to argocd.int.rlservers.com)' if d.get('success') else 'Delete argocd: ' + str(d.get('errors','')))"
else
  echo "  argocd.rlservers.com not in Cloudflare (already removed or never existed)"
fi
# Create or update api-netbird.rlservers.com (DNS-only for gRPC reliability)
EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=A&name=api-netbird.rlservers.com" \
  -H "Authorization: Bearer $CF_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')" 2>/dev/null)
if [ -z "$EXISTING" ]; then
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    -d '{"type":"A","name":"api-netbird.rlservers.com","content":"84.82.69.110","ttl":1,"proxied":false}' | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('Created: api-netbird.rlservers.com -> 84.82.69.110 (DNS-only)' if d.get('success') else 'Error: ' + str(d.get('errors','')))"
else
  curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${EXISTING}" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    -d '{"type":"A","name":"api-netbird.rlservers.com","content":"84.82.69.110","ttl":1,"proxied":false}' | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('Updated: api-netbird.rlservers.com -> proxied=false (DNS-only)' if d.get('success') else 'Error: ' + str(d.get('errors','')))"
fi

