#!/usr/bin/env bash
# generate-recovery-links.sh
# Generates Authentik password recovery links for all users with send_recovery_email: true
# in users.yaml. Exports links as env vars for the deploy email script.
#
# Usage: source generate-recovery-links.sh <KUBECONFIG> [USERS_YAML]
#   Must be sourced (not executed) so the exported vars are available to the caller.
#
# Exports: AUTHENTIK_<USERNAME>_RECOVERY_LINK for each qualifying user
#
# Prerequisites:
#   - Authentik server running with port-forward on 8089
#   - AUTHENTIK_ADMIN_TOKEN env var set
set -euo pipefail

KB="${1:?missing KUBECONFIG}"
USERS_YAML="${2:-./users.yaml}"
KT="kubectl --kubeconfig $KB --insecure-skip-tls-verify"

if [ ! -f "$USERS_YAML" ]; then
  echo "⚠ users.yaml not found at $USERS_YAML — skipping recovery link generation"
  exit 0
fi

if [ -z "${AUTHENTIK_ADMIN_TOKEN:-}" ]; then
  echo "⚠ AUTHENTIK_ADMIN_TOKEN not set — skipping recovery link generation"
  exit 0
fi

# Set up port-forward to Authentik server
$KT port-forward svc/authentik-server -n authentik 8089:80 > /tmp/authentik-pf-recovery.log 2>&1 &
PF_PID=$!
trap "kill $PF_PID 2>/dev/null || true" EXIT

sleep 3

# Get list of users who should receive recovery emails
RECOVERY_USERS=$(python3 -c "
import yaml, sys
with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)
for u in config.get('users', []):
    if u.get('send_recovery_email', False):
        print(u['username'])
" "$USERS_YAML" 2>/dev/null)

for USERNAME in $RECOVERY_USERS; do
  USER_ID=$(curl -sf \
    -H "Authorization: Bearer ${AUTHENTIK_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    "http://localhost:8089/api/v3/core/users/?username=${USERNAME}" \
    2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['results'][0]['pk'] if d.get('results') else '')" 2>/dev/null || echo "")

  if [ -n "$USER_ID" ]; then
    RECOVERY=$(curl -sf -X POST \
      -H "Authorization: Bearer ${AUTHENTIK_ADMIN_TOKEN}" \
      -H "Content-Type: application/json" \
      "http://localhost:8089/api/v3/core/users/${USER_ID}/recovery/" \
      2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('link',''))" 2>/dev/null || echo "")

    if [ -n "$RECOVERY" ]; then
      ENVVAR="AUTHENTIK_$(echo "$USERNAME" | tr '[:lower:]' '[:upper:]')_RECOVERY_LINK"
      export "$ENVVAR"="$RECOVERY"
      echo "✅ Recovery link generated for $USERNAME"
    else
      echo "⚠ Could not generate recovery link for $USERNAME"
    fi
  else
    echo "⚠ User $USERNAME not found in Authentik"
  fi
done
