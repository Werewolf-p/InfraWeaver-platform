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
CF_ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=${BASE_DOMAIN}" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')" 2>/dev/null)
if [ -z "$CF_ZONE_ID" ]; then
  echo "⚠ Could not find ${BASE_DOMAIN} zone — skipping"
  exit 0
fi
# Delete argocd.${BASE_DOMAIN} public DNS record (ArgoCD is now VPN-only at argocd.int.${BASE_DOMAIN})
ARGOCD_PUB_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=argocd.${BASE_DOMAIN}" \
  -H "Authorization: Bearer $CF_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')" 2>/dev/null)
if [ -n "$ARGOCD_PUB_ID" ]; then
  curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${ARGOCD_PUB_ID}" \
    -H "Authorization: Bearer $CF_TOKEN" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('Deleted: argocd.${BASE_DOMAIN} (moved to argocd.int.${BASE_DOMAIN})' if d.get('success') else 'Delete argocd: ' + str(d.get('errors','')))"
else
  echo "  argocd.${BASE_DOMAIN} not in Cloudflare (already removed or never existed)"
fi

