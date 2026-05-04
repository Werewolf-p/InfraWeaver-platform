#!/usr/bin/env bash
# Seed or patch the Authentik secret in OpenBao.
# Usage: seed-openbao-authentik.sh <LOCAL_OPENBAO> <ROOT_TOKEN>
# Creates secret/platform/authentik if absent; patches missing fields in if needed.
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
      \"secret-key\": \"$(openssl rand -base64 40 | tr -d '/+=')\",
      \"postgresql-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"bootstrap-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"bootstrap-token\": \"$(openssl rand -base64 30 | tr -d '/+=')\",
      \"remon-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"ardaty-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"testuser2-password\": \"$(openssl rand -base64 18 | tr -d '/+=')\",
      \"smtp-host\": \"smtp-mail.outlook.com\",
      \"smtp-port\": \"587\",
      \"smtp-username\": \"placeholder@rlservers.com\",
      \"smtp-password\": \"placeholder\",
      \"smtp-from\": \"placeholder@rlservers.com\"
    }}" > /dev/null
  echo "==> Authentik secrets written (randomly generated, smtp placeholders)"
else
  # Get existing data and patch any missing fields
  EXISTING_DATA=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
    "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('data',{}).get('data',{})))" \
    2>/dev/null || echo "{}")

  PATCHED=$(python3 -c "
import json, sys, subprocess
d = json.loads(sys.argv[1])
changed = False

def rand_b64(n):
    return subprocess.check_output(['openssl','rand','-base64',str(n)]).decode().strip().replace('/','').replace('+','').replace('=','')

if 'remon-password' not in d:
    d['remon-password'] = rand_b64(18)
    changed = True
if 'ardaty-password' not in d:
    d['ardaty-password'] = rand_b64(18)
    changed = True
if 'testuser2-password' not in d:
    d['testuser2-password'] = rand_b64(18)
    changed = True
if 'postgresql-password' not in d:
    d['postgresql-password'] = rand_b64(18)
    changed = True
if 'bootstrap-token' not in d:
    d['bootstrap-token'] = rand_b64(30)
    changed = True
if 'smtp-host' not in d:
    d['smtp-host'] = 'smtp-mail.outlook.com'
    d['smtp-port'] = '587'
    d['smtp-username'] = 'placeholder@rlservers.com'
    d['smtp-password'] = 'placeholder'
    d['smtp-from'] = 'placeholder@rlservers.com'
    changed = True
sys.stdout.write(json.dumps({'data': d}) if changed else '')
" "$EXISTING_DATA" 2>/dev/null || echo "")

  if [ -n "$PATCHED" ]; then
    curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" \
      -H "X-Vault-Token: $ROOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PATCHED" > /dev/null
    echo "==> Authentik secrets patched (added missing fields)"
  else
    echo "==> Authentik secrets already exist — preserving"
  fi
fi
