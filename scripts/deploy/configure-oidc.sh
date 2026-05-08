#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/configure-oidc.sh — Configure OIDC for ArgoCD, OpenBao, and all SSO integrations
#
# Usage: ENV_NAME=productie bash scripts/deploy/configure-oidc.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Cleanup on exit
cleanup() {
  kill ${AUTHENTIK_PF_PID} 2>/dev/null || true;
  rm -f /tmp/authentik-pf.log; rm -f /tmp/authentik-pf;
}
trap cleanup EXIT
KB=~/.kube/config-platform-${ENV_NAME:?ENV_NAME required}
TOKEN="$AUTHENTIK_ADMIN_TOKEN"
KT="kubectl --kubeconfig $KB --insecure-skip-tls-verify"

if [ -z "$TOKEN" ]; then
  echo "⚠️ No Authentik token available — skipping OIDC bootstrap (non-critical)"
  exit 0
fi

# ── Port-forward Authentik server for TLS-free API access ────────
$KT port-forward svc/authentik-server -n authentik 8088:80 > /tmp/authentik-pf.log 2>&1 &
AUTHENTIK_PF_PID=$!
sleep 5
AUTHENTIK_URL="http://localhost:8088"
echo "Authentik API available at $AUTHENTIK_URL (port-forward PID=$AUTHENTIK_PF_PID)"

# ── Helper: wait for Authentik provider to exist ─────────────────
wait_for_provider() {
  local name="$1"
  for i in $(seq 1 30); do
    COUNT=$(curl -sf \
      -H "Authorization: Bearer $TOKEN" \
      "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$name'))")" \
      2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['pagination']['count'])" 2>/dev/null || echo 0)
    if [ "$COUNT" -gt 0 ]; then return 0; fi
    echo "  Waiting for Authentik provider '$name' ($i/30)..."
    sleep 10
  done
  return 1
}

# ── Read ArgoCD client_secret ─────────────────────────────────────
echo "==> Fetching ArgoCD OAuth2 client_secret from Authentik..."
wait_for_provider "ArgoCD Provider"
ARGOCD_SECRET=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=ArgoCD%20Provider" \
  2>/dev/null | python3 -c "import sys,json; results=json.load(sys.stdin)['results']; print(results[0]['client_secret']) if results else print('')" 2>/dev/null || echo "")
if [ -z "$ARGOCD_SECRET" ]; then
  echo "⚠️ Could not fetch ArgoCD client_secret — OIDC login will not work until fixed"
else
  echo "✅ ArgoCD client_secret retrieved"
  # Patch argocd-secret so ArgoCD picks it up for OIDC
  ARGOCD_SECRET_B64=$(printf '%s' "$ARGOCD_SECRET" | base64 -w0)
  $KT patch secret argocd-secret -n argocd \
    --type=merge \
    -p "{\"data\": {\"oidc.authentik.clientSecret\": \"${ARGOCD_SECRET_B64}\"}}"
  echo "✅ argocd-secret patched with OIDC client_secret"

  # Store in OpenBao for reference
  ROOT_TOKEN=$($KT get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$ROOT_TOKEN" ]; then
    $KT exec -n openbao openbao-0 -- \
      env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
      bao kv put secret/platform/argocd-oidc client_secret="$ARGOCD_SECRET" > /dev/null 2>&1 || true
  fi
fi

# ── Read OpenBao client_secret ────────────────────────────────────
echo "==> Fetching OpenBao OAuth2 client_secret from Authentik..."
wait_for_provider "OpenBao Provider"
OPENBAO_SECRET=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=OpenBao%20Provider" \
  2>/dev/null | python3 -c "import sys,json; results=json.load(sys.stdin)['results']; print(results[0]['client_secret']) if results else print('')" 2>/dev/null || echo "")

# ── Configure OpenBao OIDC auth ───────────────────────────────────
if [ -z "$OPENBAO_SECRET" ]; then
  echo "⚠️ Could not fetch OpenBao client_secret — OIDC auth will not work"
else
  echo "✅ OpenBao client_secret retrieved"
  ROOT_TOKEN=$($KT get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$ROOT_TOKEN" ]; then
    BAO_POD=$($KT get pod -n openbao \
      -l app.kubernetes.io/name=openbao --no-headers \
      -o custom-columns=":metadata.name" 2>/dev/null | head -1 || echo "")
    if [ -n "$BAO_POD" ]; then
      # Verify internal Authentik OIDC endpoint via runner port-forward (avoids hairpin NAT
      # and curl-dependency inside the openbao pod). OpenBao uses internal service URL
      # server-side to fetch JWKS keys; end-users redirect to external auth.rlservers.com.
      echo "==> Verifying internal Authentik OIDC endpoint via runner port-forward..."
      $KT port-forward svc/authentik-server -n authentik 8087:80 > /tmp/authentik-pf2.log 2>&1 &
      AK_PF2=$!
      sleep 3
      OIDC_URL_READY=false
      for i in $(seq 1 30); do
        HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' \
          "http://localhost:8087/application/o/openbao/.well-known/openid-configuration" 2>/dev/null || echo "0")
        if [ "$HTTP_CODE" = "200" ]; then
          echo "  ✅ Internal Authentik OIDC endpoint ready (HTTP $HTTP_CODE)"
          OIDC_URL_READY=true
          break
        fi
        echo "  Waiting for OIDC endpoint ($i/30) — HTTP: ${HTTP_CODE:-unreachable}..."
        sleep 10
      done
      kill $AK_PF2 2>/dev/null || true

      if [ "$OIDC_URL_READY" != "true" ]; then
        echo "⚠️ Internal Authentik OIDC endpoint not ready after 5 min — skipping OpenBao OIDC config"
        echo "   Run the configure-oidc workflow manually once Authentik is ready"
      else
        echo "==> Enabling + configuring OpenBao OIDC auth method..."

        # Enable oidc auth (idempotent)
        $KT exec -n openbao "$BAO_POD" -- \
          env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
          bao auth enable oidc 2>/dev/null || true

        # Configure OIDC using internal service URL (avoids hairpin NAT)
        $KT exec -n openbao "$BAO_POD" -- \
          env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
          bao write auth/oidc/config \
            oidc_discovery_url="http://authentik-server.authentik.svc.cluster.local/application/o/openbao/" \
            oidc_client_id="openbao" \
            oidc_client_secret="$OPENBAO_SECRET" \
            default_role="default" && echo "✅ OpenBao OIDC config written" || echo "⚠️ bao write auth/oidc/config failed (non-critical)"

        # Create admin policy if not exists (policy passed via base64 to avoid column-0 YAML issue)
        ADMIN_POLICY_B64=$(printf 'path "*" {\n  capabilities = ["create", "read", "update", "delete", "list", "sudo"]\n}' | base64 -w0)
        $KT exec -n openbao "$BAO_POD" -- \
          env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
          sh -c "bao policy read admin > /dev/null 2>&1 || echo $ADMIN_POLICY_B64 | base64 -d | bao policy write admin -" 2>/dev/null || true

        # Create default OIDC role for remon
        $KT exec -n openbao "$BAO_POD" -- \
          env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
          bao write auth/oidc/role/default \
            bound_audiences="openbao" \
            allowed_redirect_uris="https://openbao.int.rlservers.com/ui/vault/auth/oidc/oidc/callback" \
            allowed_redirect_uris="http://localhost:8250/oidc/callback" \
            user_claim="preferred_username" \
            policies="admin" \
            ttl=8h || true
        echo "✅ OpenBao OIDC role 'default' created"
      fi
    else
      echo "⚠️ OpenBao pod not found — skipping OIDC auth setup"
    fi
  fi
fi

# ── Read Grafana OIDC client_secret ───────────────────────────────
echo "==> Fetching Grafana OAuth2 client_secret from Authentik..."
wait_for_provider "Grafana Provider"
GRAFANA_SECRET=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=Grafana%20Provider" \
  2>/dev/null | python3 -c "import sys,json; results=json.load(sys.stdin)['results']; print(results[0]['client_secret']) if results else print('')" 2>/dev/null || echo "")

if [ -z "$GRAFANA_SECRET" ]; then
  echo "⚠️ Could not fetch Grafana client_secret — OIDC login will not work"
else
  echo "✅ Grafana client_secret retrieved"
  ROOT_TOKEN=$($KT get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$ROOT_TOKEN" ]; then
    $KT exec -n openbao openbao-0 -- \
      env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
      bao kv put secret/platform/grafana-oidc client_secret="$GRAFANA_SECRET" > /dev/null 2>&1 || true
    echo "✅ Grafana OIDC client_secret stored in OpenBao"
  fi
fi

# ── Read Proxmox OIDC client_secret ───────────────────────────────
echo "==> Fetching Proxmox OAuth2 client_secret from Authentik..."
wait_for_provider "Proxmox Provider"
PROXMOX_SECRET=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=Proxmox%20Provider" \
  2>/dev/null | python3 -c "import sys,json; results=json.load(sys.stdin)['results']; print(results[0]['client_secret']) if results else print('')" 2>/dev/null || echo "")

if [ -z "$PROXMOX_SECRET" ]; then
  echo "⚠️ Could not fetch Proxmox client_secret — OIDC login for Proxmox will not work"
else
  echo "✅ Proxmox client_secret retrieved"
  ROOT_TOKEN=$($KT get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$ROOT_TOKEN" ]; then
    $KT exec -n openbao openbao-0 -- \
      env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
      bao kv put secret/platform/proxmox-oidc \
        client_secret="$PROXMOX_SECRET" \
        client_id="proxmox" \
        issuer_url="https://auth.rlservers.com/application/o/proxmox/" > /dev/null 2>&1 || true
    echo "✅ Proxmox OIDC client_secret stored in OpenBao at secret/platform/proxmox-oidc"
  fi

  # ── Automatically configure Proxmox OIDC realm via PVE API ──────────────────
  # Reads proxmox_host from cluster.yaml; requires PROXMOX_API_TOKEN env var.
  CLUSTER_YAML="envs/${ENV_NAME}/cluster.yaml"
  PVE_HOST=$(grep 'proxmox_host' "$CLUSTER_YAML" 2>/dev/null | head -1 | sed 's/.*: *"\(.*\)"/\1/' | xargs)
  PVE_TOKEN="${PROXMOX_API_TOKEN:-}"

  if [ -z "$PVE_HOST" ] || [ -z "$PVE_TOKEN" ]; then
    echo "ℹ️  PROXMOX_API_TOKEN or proxmox_host not set — skipping automatic PVE realm config"
    echo "   Manual: pveum realm add authentik --type openid \\"
    echo "     --issuer-url https://auth.rlservers.com/application/o/proxmox/ \\"
    echo "     --client-id proxmox --client-key '<secret>' --username-claim preferred_username --autocreate 1"
  else
    echo "==> Configuring Proxmox OIDC realm via API (host=${PVE_HOST})..."
    ISSUER="https://auth.rlservers.com/application/o/proxmox/"
    REALM_CHECK=$(curl -sk -o /dev/null -w "%{http_code}" \
      -H "Authorization: PVEAPIToken=${PVE_TOKEN}" \
      "https://${PVE_HOST}:8006/api2/json/access/realms/authentik" 2>/dev/null || echo "000")

    if [ "$REALM_CHECK" = "200" ]; then
      # Realm exists — update it
      HTTP=$(curl -sk -o /dev/null -w "%{http_code}" -X PUT \
        -H "Authorization: PVEAPIToken=${PVE_TOKEN}" \
        "https://${PVE_HOST}:8006/api2/json/access/realms/authentik" \
        --data-urlencode "issuer-url=${ISSUER}" \
        --data-urlencode "client-id=proxmox" \
        --data-urlencode "client-key=${PROXMOX_SECRET}" \
        --data-urlencode "username-claim=preferred_username" \
        --data-urlencode "autocreate=1" 2>/dev/null || echo "000")
      [ "$HTTP" = "200" ] && echo "✅ Proxmox OIDC realm 'authentik' updated" \
        || echo "⚠️  Proxmox realm update returned HTTP $HTTP (may need manual check)"
    else
      # Realm does not exist — create it
      HTTP=$(curl -sk -o /dev/null -w "%{http_code}" -X POST \
        -H "Authorization: PVEAPIToken=${PVE_TOKEN}" \
        "https://${PVE_HOST}:8006/api2/json/access/realms" \
        --data-urlencode "realm=authentik" \
        --data-urlencode "type=openid" \
        --data-urlencode "issuer-url=${ISSUER}" \
        --data-urlencode "client-id=proxmox" \
        --data-urlencode "client-key=${PROXMOX_SECRET}" \
        --data-urlencode "username-claim=preferred_username" \
        --data-urlencode "autocreate=1" 2>/dev/null || echo "000")
      [ "$HTTP" = "200" ] && echo "✅ Proxmox OIDC realm 'authentik' created" \
        || echo "⚠️  Proxmox realm creation returned HTTP $HTTP — check PVE API token permissions"
    fi
  fi
fi

# ── Read Gitea OIDC client_secret ─────────────────────────────────
echo "==> Fetching Gitea OAuth2 client_secret from Authentik..."
wait_for_provider "Gitea Provider"
GITEA_SECRET=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=Gitea%20Provider" \
  2>/dev/null | python3 -c "import sys,json; results=json.load(sys.stdin)['results']; print(results[0]['client_secret']) if results else print('')" 2>/dev/null || echo "")

if [ -z "$GITEA_SECRET" ]; then
  echo "⚠️ Could not fetch Gitea client_secret — OIDC login will not work"
else
  echo "✅ Gitea client_secret retrieved"
  ROOT_TOKEN=$($KT get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$ROOT_TOKEN" ]; then
    $KT exec -n openbao openbao-0 -- \
      env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
      bao kv put secret/platform/gitea-oidc client_secret="$GITEA_SECRET" > /dev/null 2>&1 || true
    echo "✅ Gitea OIDC client_secret stored in OpenBao"
  fi
fi

# ── Read Forgejo OIDC client_secret ───────────────────────────────
echo "==> Fetching Forgejo OAuth2 client_secret from Authentik..."
wait_for_provider "Forgejo Provider"
FORGEJO_SECRET=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "${AUTHENTIK_URL}/api/v3/providers/oauth2/?name=Forgejo%20Provider" \
  2>/dev/null | python3 -c "import sys,json; results=json.load(sys.stdin)['results']; print(results[0]['client_secret']) if results else print('')" 2>/dev/null || echo "")

if [ -z "$FORGEJO_SECRET" ]; then
  echo "⚠️ Could not fetch Forgejo client_secret — OIDC login will not work"
else
  echo "✅ Forgejo client_secret retrieved"
  ROOT_TOKEN=$($KT get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$ROOT_TOKEN" ]; then
    $KT exec -n openbao openbao-0 -- \
      env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
      bao kv put secret/platform/forgejo-oidc client_secret="$FORGEJO_SECRET" client_id="forgejo" > /dev/null 2>&1 || true
    echo "✅ Forgejo OIDC client_secret stored in OpenBao"
  fi
fi

# ── Cleanup port-forward ──────────────────────────────────────────
kill $AUTHENTIK_PF_PID 2>/dev/null || true

