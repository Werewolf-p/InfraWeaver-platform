#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/refresh-tls-backup.sh — Backup TLS secrets to TrueNAS for persistent TLS across redeploys
#
# Usage: ENV_NAME=productie bash scripts/deploy/refresh-tls-backup.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
KB=~/.kube/config-platform-${ENV_NAME:?ENV_NAME required}
BACKUP_DIR=/opt/platform-tls-backup
mkdir -p "$BACKUP_DIR"
# Wait for both certs — each has its own loop
# rlservers-com-wildcard: HTTP-01, usually fast (~2-5 min)
# int-rlservers-com-wildcard: DNS-01 via Cloudflare, can take up to 10 min
# Both may be rate-limited on repeated deploys — warn but don't fail
for cert in rlservers-com-wildcard int-rlservers-com-wildcard; do
  echo "==> Waiting for cert ${cert} to be ready (up to 15 min)..."
  for i in $(seq 1 90); do
    READY=$(kubectl --kubeconfig "$KB" --insecure-skip-tls-verify get certificate \
      "$cert" -n traefik -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [ "$READY" = "True" ]; then
      echo "  ✅ ${cert} is ready"
      break
    fi
    REASON=$(kubectl --kubeconfig "$KB" --insecure-skip-tls-verify get certificate \
      "$cert" -n traefik -o jsonpath='{.status.conditions[?(@.type=="Issuing")].reason}' 2>/dev/null || echo "")
    if [ "$REASON" = "Failed" ]; then
      echo "  ⚠ ${cert} issuance failed (likely LE rate limit) — skipping wait, backup will be skipped"
      break
    fi
    echo "  Waiting for ${cert} ($i/90)..."
    sleep 10
  done
done
echo "==> Saving available TLS secret backups..."
for secret in rlservers-com-wildcard-tls int-rlservers-com-tls; do
  YAML=$(kubectl --kubeconfig "$KB" --insecure-skip-tls-verify get secret "$secret" -n traefik -o yaml 2>/dev/null || echo "")
  if [ "${#YAML}" -gt 100 ]; then
    # Base64-encoded Python avoids YAML column-0 parsing issues in block scalars.
    _CERT_PY="aW1wb3J0IHN5cywgYmFzZTY0LCBzdWJwcm9jZXNzLCByZQpkYXRhID0gc3lzLnN0ZGluLnJlYWQoKQptID0gcmUuc2VhcmNoKHIidGxzXC5jcnQ6IChbQS1aYS16MC05Ky89XSspIiwgZGF0YSkKaWYgbToKICAgIGNydCA9IGJhc2U2NC5iNjRkZWNvZGUobS5ncm91cCgxKSkKICAgIHIgPSBzdWJwcm9jZXNzLnJ1bihbIm9wZW5zc2wiLCJ4NTA5IiwiLW5vb3V0IiwiLWlzc3VlciJdLCBpbnB1dD1jcnQsIGNhcHR1cmVfb3V0cHV0PVRydWUpCiAgICBwcmludChyLnN0ZG91dC5kZWNvZGUoKS5zdHJpcCgpKQo="
    CERT_ISSUER=$(echo "$YAML" | python3 <(echo "$_CERT_PY" | base64 -d) 2>/dev/null || echo "unknown")
    if echo "$CERT_ISSUER" | grep -qi "Let's Encrypt\|letsencrypt\|ISRG"; then
      echo "$YAML" > "$BACKUP_DIR/${secret}.yaml"
      echo "  ✅ Backup updated: $secret (${#YAML} bytes, issuer: $CERT_ISSUER)"
    else
      echo "  ⚠ $secret issuer is not Let's Encrypt ($CERT_ISSUER) — keeping existing backup"
    fi
  else
    echo "  ⚠ $secret not available for backup (rate-limited or not yet issued)"
  fi
done

