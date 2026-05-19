#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/configure-authentik.sh — Set Authentik admin privileges, groups, and SSO providers
#
# Usage: ENV_NAME=productie bash scripts/deploy/configure-authentik.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Cleanup on exit
SETUP_PF_PID=""
AK_PF_PID=""
cleanup() {
  [[ -n "${SETUP_PF_PID:-}" ]] && kill "$SETUP_PF_PID" 2>/dev/null || true
  [[ -n "${AK_PF_PID:-}" ]] && kill "$AK_PF_PID" 2>/dev/null || true
  rm -f /tmp/ak_groups.py /tmp/authentik-pf-setup.log /tmp/users.yaml /tmp/ak_token.py
}
trap cleanup EXIT
KB=~/.kube/config-platform-${ENV_NAME:?ENV_NAME required}
KT="kubectl --kubeconfig $KB --insecure-skip-tls-verify"

# Wait for Authentik worker to be ready — replaces separate ArgoCD health check + rollout
# Directly polls the deployment readyReplicas (10s intervals, up to 12 minutes).
# Faster than waiting for ArgoCD app health first (saves the ArgoCD health loop overhead).
echo "==> Waiting for Authentik worker deployment to be ready..."
$KT wait deployment/authentik-worker -n authentik \
  --for=condition=Available --timeout=1200s
# Also wait for the pod itself to be Ready (Available != pod Ready)
$KT wait pod -n authentik -l app.kubernetes.io/component=worker \
  --for=condition=Ready --timeout=120s 2>/dev/null || true
echo "  ✅ Authentik worker ready"

# Use deploy/authentik-worker -c worker instead of pod name throughout this step.
# This always routes to a live pod even if the pod restarts during this step.
AK_EXEC="$KT exec -n authentik deploy/authentik-worker -c worker --"

# Wait for all users defined in users.yaml to be created (parallel checks).
# Blueprints create users async; worker may be ready before users exist.
_wait_for_user() {
  local username="$1"
  echo "==> Waiting for ${username} user to be created by blueprint..."
  for i in $(seq 1 60); do
    # Use | tail -1 to strip ak shell JSON boot logs from stdout,
    # keeping only the final print() output ("yes" or "no")
    USER_EXISTS=$($KT exec -n authentik deploy/authentik-worker -c worker -- ak shell -c \
      "from authentik.core.models import User; print('yes' if User.objects.filter(username='${username}').exists() else 'no')" \
      2>/dev/null | tail -1 || echo "no")
    [ "$USER_EXISTS" = "yes" ] && echo "  ✅ ${username} user found" && return 0
    echo "  [${i}/60] ${username} exists: no"
    sleep 10
  done
  echo "  ⚠️ ${username} user not found after timeout — continuing anyway"
  return 1
}
# Launch all user checks in parallel
# Base64-encoded Python avoids YAML column-0 parsing issues in block scalars.
_ALL_USERS_PY="aW1wb3J0IHlhbWwKdXNlcnMgPSB5YW1sLnNhZmVfbG9hZChvcGVuKCJ1c2Vycy55YW1sIikpWyJ1c2VycyJdCmZvciB1IGluIHVzZXJzOgogICAgcHJpbnQodSkK"
declare -a USER_WAIT_PIDS=()
for _uname in $(echo "$_ALL_USERS_PY" | base64 -d | python3); do
  _wait_for_user "$_uname" &
  USER_WAIT_PIDS+=($!)
done
# Wait for all parallel checks to complete
for _pid in "${USER_WAIT_PIDS[@]}"; do
  wait "$_pid" || true
done
echo "==> Setting user group memberships..."
# Dynamic: reads from users.yaml (authentik_groups per user) — no hardcoded usernames.
# Base64-encoded Python avoids YAML column-0 parsing issues in block scalars.
# Script reads authentik_groups from users.yaml; sets is_superuser for 'authentik Admins'.
_GROUPS_PY="aW1wb3J0IHlhbWwKZnJvbSBhdXRoZW50aWsuY29yZS5tb2RlbHMgaW1wb3J0IFVzZXIsIEdyb3VwCgp3aXRoIG9wZW4oJy90bXAvdXNlcnMueWFtbCcsICdyJykgYXMgZjoKICAgIHVzZXJzX2RhdGEgPSB5YW1sLnNhZmVfbG9hZChmKQoKZm9yIHVzZXJuYW1lLCB1c2VyX2NmZyBpbiB1c2Vyc19kYXRhLmdldCgndXNlcnMnLCB7fSkuaXRlbXMoKToKICAgIHRyeToKICAgICAgICB1c2VyID0gVXNlci5vYmplY3RzLmdldCh1c2VybmFtZT11c2VybmFtZSkKICAgIGV4Y2VwdCBVc2VyLkRvZXNOb3RFeGlzdDoKICAgICAgICBwcmludCgnV0FSTjogVXNlciAnICsgdXNlcm5hbWUgKyAnIG5vdCBmb3VuZCwgc2tpcHBpbmcnKQogICAgICAgIGNvbnRpbnVlCgogICAgZ3JvdXBzID0gdXNlcl9jZmcuZ2V0KCdhdXRoZW50aWtfZ3JvdXBzJywgW10pCiAgICBmb3IgZ3JvdXBfbmFtZSBpbiBncm91cHM6CiAgICAgICAgZ3JwLCBfID0gR3JvdXAub2JqZWN0cy5nZXRfb3JfY3JlYXRlKG5hbWU9Z3JvdXBfbmFtZSkKICAgICAgICBncnAudXNlcnMuYWRkKHVzZXIpCiAgICAgICAgcHJpbnQoJ09LOiBBZGRlZCAnICsgdXNlcm5hbWUgKyAnIHRvICcgKyBncm91cF9uYW1lKQoKICAgIGlmICdhdXRoZW50aWsgQWRtaW5zJyBpbiBncm91cHM6CiAgICAgICAgdXNlci5pc19zdXBlcnVzZXIgPSBUcnVlCiAgICAgICAgdXNlci5zYXZlKCkKICAgICAgICBwcmludCgnT0s6IFNldCAnICsgdXNlcm5hbWUgKyAnIGFzIHN1cGVydXNlcicpCg=="
# Two fast atomic execs using deploy/ target — avoids stale pod name issue.
# deploy/authentik-worker resolves to the current live pod each time.
cat users.yaml | $KT exec -i -n authentik deploy/authentik-worker -c worker -- sh -c 'cat > /tmp/users.yaml'
echo "$_GROUPS_PY" | base64 -d | \
  $KT exec -i -n authentik deploy/authentik-worker -c worker -- \
  sh -c 'cat > /tmp/ak_groups.py && ak shell < /tmp/ak_groups.py' 2>&1 | tail -10
echo "✅ User group memberships set"

# Generate recovery links for all users with send_recovery_email: true
# Stores AUTHENTIK_{USERNAME_UPPER}_RECOVERY_LINK in $GITHUB_ENV for email step
echo "==> Configuring recovery flow and generating password recovery links..."
_AK_PY="ZnJvbSBhdXRoZW50aWsuY29yZS5tb2RlbHMgaW1wb3J0IFRva2VuLCBUb2tlbkludGVudHMsIFVzZXIKZnJvbSBhdXRoZW50aWsuYnJhbmRzLm1vZGVscyBpbXBvcnQgQnJhbmQKZnJvbSBhdXRoZW50aWsuZmxvd3MubW9kZWxzIGltcG9ydCBGbG93LCBGbG93RGVzaWduYXRpb24KCmZsb3csIF8gPSBGbG93Lm9iamVjdHMuZ2V0X29yX2NyZWF0ZShzbHVnPSJkZWZhdWx0LXJlY292ZXJ5LWZsb3ciLCBkZWZhdWx0cz17Im5hbWUiOiAiRGVmYXVsdCBSZWNvdmVyeSBGbG93IiwgInRpdGxlIjogIkFjY291bnQgUmVjb3ZlcnkiLCAiZGVzaWduYXRpb24iOiBGbG93RGVzaWduYXRpb24uUkVDT1ZFUll9KQpmb3IgYnJhbmQgaW4gQnJhbmQub2JqZWN0cy5hbGwoKToKICAgIGJyYW5kLmZsb3dfcmVjb3ZlcnkgPSBmbG93CiAgICBicmFuZC5zYXZlKCkKClRva2VuLm9iamVjdHMuZmlsdGVyKGlkZW50aWZpZXI9ImdoLWFjdGlvbnMtYXBpLXRva2VuIikuZGVsZXRlKCkKYWRtaW4gPSBVc2VyLm9iamVjdHMuZ2V0KHVzZXJuYW1lPSJha2FkbWluIikKdCA9IFRva2VuLm9iamVjdHMuY3JlYXRlKGlkZW50aWZpZXI9ImdoLWFjdGlvbnMtYXBpLXRva2VuIiwgdXNlcj1hZG1pbiwgZGVzY3JpcHRpb249IkdpdEh1YiBBY3Rpb25zIEFQSSB0b2tlbiIsIGludGVudD1Ub2tlbkludGVudHMuSU5URU5UX0FQSSwgZXhwaXJpbmc9RmFsc2UpCnByaW50KCJUT0tFTjoiICsgdC5rZXkpCg=="
# Single atomic exec: write script and run it in one connection to avoid stale pod name.
AUTHENTIK_ADMIN_TOKEN=$(echo "$_AK_PY" | base64 -d | \
  $KT exec -i -n authentik deploy/authentik-worker -c worker -- \
  sh -c 'cat > /tmp/ak_token.py && ak shell < /tmp/ak_token.py' \
  2>&1 | grep "^TOKEN:" | sed 's/TOKEN://' || echo "")
echo "AUTHENTIK_ADMIN_TOKEN=${AUTHENTIK_ADMIN_TOKEN}" >> "${GITHUB_ENV:-/dev/null}"

$KT port-forward svc/authentik-server -n authentik 8089:80 > /tmp/authentik-pf-setup.log 2>&1 &
SETUP_PF_PID=$!
sleep 4

if [ -n "$AUTHENTIK_ADMIN_TOKEN" ]; then
  # Generate recovery links for ADMIN users only — these go in the admin deploy email.
  # Non-admin users get their own welcome email via the next step.
  # Base64-encoded Python avoids YAML column-0 parsing issues in block scalars.
  _ADMIN_USERS_PY="aW1wb3J0IHlhbWwKdXNlcnMgPSB5YW1sLnNhZmVfbG9hZChvcGVuKCJ1c2Vycy55YW1sIikpWyJ1c2VycyJdCmZvciB1LCBkIGluIHVzZXJzLml0ZW1zKCk6CiAgICBpZiBkLmdldCgiYWNjZXNzX2xldmVsIikgPT0gImFkbWluIiBhbmQgZC5nZXQoInNlbmRfcmVjb3ZlcnlfZW1haWwiKToKICAgICAgICBwcmludCh1KQo="
  for USERNAME in $(echo "$_ADMIN_USERS_PY" | base64 -d | python3); do
    USER_ID=$(curl -sf \
      -H "Authorization: Bearer $AUTHENTIK_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      "http://localhost:8089/api/v3/core/users/?username=${USERNAME}" \
      2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print(r[0]['pk'] if r else '')" 2>/dev/null || echo "")
    if [ -n "$USER_ID" ]; then
      RECOVERY=$(curl -sf -X POST \
        -H "Authorization: Bearer $AUTHENTIK_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        "http://localhost:8089/api/v3/core/users/$USER_ID/recovery/" \
        2>/dev/null || echo "")
      if [ -n "$RECOVERY" ]; then
        LINK=$(echo "$RECOVERY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('link',''))" 2>/dev/null || echo "")
        LINK=$(echo "$LINK" | sed 's|http://localhost:8089|https://auth.rlservers.com|g')
        ENV_VAR="AUTHENTIK_$(echo "$USERNAME" | tr '[:lower:]' '[:upper:]')_RECOVERY_LINK"
        echo "${ENV_VAR}=${LINK}" >> "${GITHUB_ENV:-/dev/null}"
        echo "✅ Recovery link generated for ${USERNAME}"
      else
        echo "⚠️ Recovery link request failed for ${USERNAME} (non-critical)"
      fi
    else
      echo "⚠️ Could not find user ${USERNAME} in Authentik (non-critical)"
    fi
  done
else
  echo "⚠️ Could not get Authentik admin token for recovery links (non-critical)"
fi
kill $SETUP_PF_PID 2>/dev/null || true

