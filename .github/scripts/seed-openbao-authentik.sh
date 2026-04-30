#!/usr/bin/env bash
# Seed or patch the Authentik secret in OpenBao.
# Usage: seed-openbao-authentik.sh <LOCAL_OPENBAO> <ROOT_TOKEN>
# Creates secret/platform/authentik if absent; patches remon-password in if missing.
set -euo pipefail

LOCAL_OPENBAO="${1:?missing LOCAL_OPENBAO}"
ROOT_TOKEN="${2:?missing ROOT_TOKEN}"

EXISTING_AUTH=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
  "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('data',{}).get('bootstrap-password',''))" \
  2>/dev/null || echo "")

if [ -z "$EXISTING_AUTH" ]; then
  curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\": {
      \"secret-key\": \"$(openssl rand -base64 40 | tr -d '/+='),\",
      \"postgresql-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"bootstrap-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"bootstrap-token\": \"$(openssl rand -base64 30 | tr -d '/+=')\",
      \"remon-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\"
    }}" > /dev/null
  echo "==> Authentik secrets written (randomly generated)"
else
  # Add remon-password if missing from existing secret
  EXISTING_REMON=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
    "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('data',{}).get('remon-password',''))" \
    2>/dev/null || echo "")
  if [ -z "$EXISTING_REMON" ]; then
    EXISTING_DATA=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
      "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" | \
      python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('data',{}).get('data',{})))" \
      2>/dev/null || echo "{}")
    REMON_PASS="$(openssl rand -base64 18 | tr -d '/+=')"
    PATCHED=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
d['remon-password'] = sys.argv[2]
print(json.dumps({'data': d}))
" "$EXISTING_DATA" "$REMON_PASS" 2>/dev/null || echo "")
    if [ -n "$PATCHED" ]; then
      curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" \
        -H "X-Vault-Token: $ROOT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$PATCHED" > /dev/null
      echo "==> Authentik remon-password added to existing secret"
    fi
  else
    echo "==> Authentik secrets already exist (including remon-password) — preserving"
  fi
fi
