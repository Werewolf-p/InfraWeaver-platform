#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/bootstrap-openbao.sh — Initialize and unseal OpenBao, seed all platform secrets
#
# Usage: ENV_NAME=productie bash scripts/deploy/bootstrap-openbao.sh
# Called by: .github/workflows/full-redeploy.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Cleanup on exit
PF_PID=""
cleanup() {
  [[ -n "${PF_PID:-}" ]] && kill "${PF_PID}" 2>/dev/null || true
}
trap cleanup EXIT
ENV=${ENV_NAME:?ENV_NAME required}
KB=~/.kube/config-platform-$ENV
LOCAL_OPENBAO="http://127.0.0.1:8200"
# In-cluster OpenBao address (ClusterIP service, accessible via NetBird)
OPENBAO_ADDR="http://openbao.openbao.svc.cluster.local:8200"

# Apply RBAC so the autounseal sidecar can read the openbao-unseal secret
kubectl --kubeconfig "$KB" apply -f kubernetes/core/openbao/manifests/rbac.yaml 2>/dev/null || true

# Pre-create openbao-unseal secret with placeholder values so the autounseal
# sidecar volume mount doesn't block the pod from starting. Real values are
# written below after OpenBao is initialised.
# IMPORTANT: Only create with placeholders if no real values exist yet —
# re-running this script must NOT overwrite real tokens with placeholders.
kubectl --kubeconfig "$KB" create namespace openbao --dry-run=client -o yaml \
  | kubectl --kubeconfig "$KB" apply -f -
_EXISTING_RT=$(kubectl --kubeconfig "$KB" get secret openbao-unseal \
  -n openbao -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
if [ -z "$_EXISTING_RT" ] || [ "$_EXISTING_RT" = "placeholder" ]; then
  kubectl --kubeconfig "$KB" create secret generic openbao-unseal \
    -n openbao \
    --from-literal=unseal_key="placeholder" \
    --from-literal=root_token="placeholder" \
    --dry-run=client -o yaml | kubectl --kubeconfig "$KB" apply -f -
  echo "==> openbao-unseal placeholder secret created"
else
  echo "==> openbao-unseal already has real values — preserving"
fi

# Wait for Longhorn to be ready (OpenBao PVC needs Longhorn storage)
echo "==> Waiting for Longhorn manager to be Running..."
for i in $(seq 1 30); do
  LHCOUNT=$(kubectl --kubeconfig "$KB" get pods -n longhorn-system \
    --no-headers 2>/dev/null | grep "longhorn-manager" | grep -c "Running" 2>/dev/null || true)
  LHCOUNT="${LHCOUNT:-0}"
  if [ "${LHCOUNT}" -gt "0" ] 2>/dev/null; then
    echo "  Longhorn manager running (${LHCOUNT} pod(s))"
    break
  fi
  echo "  Waiting for Longhorn ($i/30)..."
  sleep 10
done

# Wait for ArgoCD to discover and create the core-openbao Application
# Skip this wait if OpenBao is already deployed and running (local deploy scenario)
if kubectl --kubeconfig "$KB" get pods -n openbao \
    -l app.kubernetes.io/name=openbao --no-headers 2>/dev/null | grep -q "Running"; then
  echo "==> OpenBao already running — skipping ArgoCD sync wait"
else
  echo "==> Waiting for ArgoCD to discover core-openbao Application..."
  BAO_APP=""
  for i in $(seq 1 30); do
    BAO_APP=$(kubectl --kubeconfig "$KB" get applications -n argocd \
      --no-headers -o custom-columns=":metadata.name" 2>/dev/null | \
      grep -i "openbao" | head -1 || echo "")
    if [ -n "$BAO_APP" ]; then
      echo "  ArgoCD Application '$BAO_APP' found"
      break
    fi
    echo "  Waiting for ArgoCD to discover openbao ($i/30)..."
    sleep 10
  done

  if [ -n "$BAO_APP" ]; then
    echo "==> Waiting for ArgoCD Application '$BAO_APP' to sync..."
    for i in $(seq 1 18); do
      SYNC=$(kubectl --kubeconfig "$KB" get application "$BAO_APP" -n argocd \
        -o jsonpath='{.status.sync.status}' 2>/dev/null || echo "Unknown")
      echo "  [$i/18] sync=$SYNC"
      if [ "$SYNC" = "Synced" ]; then break; fi
      sleep 10
    done
  fi
fi

# Wait for OpenBao pod to be Running (not necessarily Ready — readiness requires unsealed)
echo "==> Waiting for OpenBao pod to be Running (up to 10 min)..."
for i in $(seq 1 60); do
  RUNNING=$(kubectl --kubeconfig "$KB" get pods -n openbao \
    -l app.kubernetes.io/name=openbao --no-headers 2>/dev/null | \
    grep -c "Running" 2>/dev/null || true)
  RUNNING="${RUNNING:-0}"
  if [ "${RUNNING}" -gt "0" ] 2>/dev/null; then
    echo "  OpenBao pod Running"
    break
  fi
  echo "  Waiting for OpenBao pod ($i/60)..."
  if [ $(( i % 15 )) -eq 0 ]; then
    echo "  --- Diagnostics at iteration $i ---"
    kubectl --kubeconfig "$KB" get pods -n openbao 2>/dev/null || echo "  (openbao namespace not found)"
    BAO_APP_NOW=$(kubectl --kubeconfig "$KB" get applications -n argocd \
      --no-headers -o custom-columns=":metadata.name" 2>/dev/null | grep -i "openbao" || echo "")
    if [ -n "$BAO_APP_NOW" ]; then
      kubectl --kubeconfig "$KB" get application "$BAO_APP_NOW" -n argocd \
        -o jsonpath='  sync={.status.sync.status} health={.status.health.status}\n' 2>/dev/null || true
    fi
  fi
  sleep 10
done

# Port-forward directly to the pod (avoids endpoint readiness gate)
BAO_POD=$(kubectl --kubeconfig "$KB" get pod -n openbao \
  -l app.kubernetes.io/name=openbao --no-headers \
  -o custom-columns=":metadata.name" 2>/dev/null | head -1)
if [ -z "$BAO_POD" ]; then
  echo "ERROR: OpenBao pod not found after waiting — cannot proceed"
  exit 1
fi
echo "Using OpenBao pod: $BAO_POD"
kubectl --kubeconfig "$KB" port-forward -n openbao "pod/${BAO_POD}" 8200:8200 &
PF_PID=$!
sleep 5

# Check initialisation status
INIT_STATUS=$(curl -s "${LOCAL_OPENBAO}/v1/sys/init" | \
  python3 -c "import json,sys; print(json.load(sys.stdin).get('initialized', False))" \
  2>/dev/null || echo "False")

if [ "$INIT_STATUS" != "True" ]; then
  echo "==> Initializing OpenBao (first deploy)..."
  INIT_OUTPUT=$(curl -s -X POST "${LOCAL_OPENBAO}/v1/sys/init" \
    -H "Content-Type: application/json" \
    -d '{"secret_shares": 1, "secret_threshold": 1}' || echo "")

  UNSEAL_KEY=$(echo "$INIT_OUTPUT" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d['keys_base64'][0])" \
    2>/dev/null || echo "")
  ROOT_TOKEN=$(echo "$INIT_OUTPUT" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d['root_token'])" \
    2>/dev/null || echo "")

  if [ -z "$UNSEAL_KEY" ] || [ -z "$ROOT_TOKEN" ]; then
    echo "ERROR: Init output missing keys:"
    echo "$INIT_OUTPUT"
    kill $PF_PID 2>/dev/null || true
    exit 1
  fi

  # Store unseal key + root token as k8s Secret (RBAC-protected)
  kubectl --kubeconfig "$KB" create namespace openbao \
    --dry-run=client -o yaml | kubectl --kubeconfig "$KB" apply -f -
  kubectl --kubeconfig "$KB" create secret generic openbao-unseal \
    -n openbao \
    --from-literal=unseal_key="$UNSEAL_KEY" \
    --from-literal=root_token="$ROOT_TOKEN" \
    --dry-run=client -o yaml | kubectl --kubeconfig "$KB" apply -f -

  # Unseal via the API
  curl -s -X POST "${LOCAL_OPENBAO}/v1/sys/unseal" \
    -H "Content-Type: application/json" \
    -d "{\"key\": \"$UNSEAL_KEY\"}" > /dev/null || true
  echo "==> OpenBao initialized and unsealed"

  # Wait for pod to become Ready after unseal (up to 3 min)
  echo "==> Waiting for OpenBao pod to become Ready after unseal..."
  kubectl --kubeconfig "$KB" wait pod -n openbao \
    -l app.kubernetes.io/name=openbao \
    --for=condition=Ready --timeout=180s 2>/dev/null && \
    echo "  OpenBao pod Ready" || echo "  (pod not yet Ready — continuing anyway)"
else
  echo "==> OpenBao already initialized — checking seal status..."
  UNSEAL_KEY=$(kubectl --kubeconfig "$KB" get secret openbao-unseal \
    -n openbao -o jsonpath='{.data.unseal_key}' 2>/dev/null | base64 -d || echo "")
  ROOT_TOKEN=$(kubectl --kubeconfig "$KB" get secret openbao-unseal \
    -n openbao -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
  SEALED=$(curl -s "${LOCAL_OPENBAO}/v1/sys/seal-status" | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('sealed', True))" \
    2>/dev/null || echo "True")
  if [ "$SEALED" != "False" ] && [ -n "$UNSEAL_KEY" ]; then
    curl -s -X POST "${LOCAL_OPENBAO}/v1/sys/unseal" \
      -H "Content-Type: application/json" \
      -d "{\"key\": \"$UNSEAL_KEY\"}" > /dev/null || true
    echo "==> Unsealed"
  fi
fi

if [ -z "$ROOT_TOKEN" ]; then
  echo "⚠ No root token available — skipping OpenBao configuration"
  kill $PF_PID 2>/dev/null || true
  exit 0
fi

# Enable KV v2 at path "secret" (idempotent — 400 if already mounted is OK)
curl -s -X POST "${LOCAL_OPENBAO}/v1/sys/mounts/secret" \
  -H "X-Vault-Token: $ROOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "kv", "options": {"version": "2"}}' > /dev/null 2>&1 || true

# Wait for KV v2 upgrade to complete (OpenBao briefly enters "upgrading" state)
echo "==> Waiting for KV v2 backend to be ready..."
for i in $(seq 1 20); do
  PROBE=$(curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/_ready_probe" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"ok":"1"}}')
  PROBE_ERR=$(echo "$PROBE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('errors',[''])[0])" 2>/dev/null || echo "parse_err")
  if echo "$PROBE_ERR" | grep -qi "upgrading"; then
    echo "  KV upgrading... ($i/20)"
    sleep 2
  else
    echo "  KV backend ready"
    # Clean up probe key (best-effort)
    curl -s -X DELETE "${LOCAL_OPENBAO}/v1/secret/metadata/_ready_probe" \
      -H "X-Vault-Token: $ROOT_TOKEN" > /dev/null 2>&1 || true
    break
  fi
done

# Write Grafana secret — only on first deploy (do not overwrite existing password)
EXISTING_GRAFANA=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
  "${LOCAL_OPENBAO}/v1/secret/data/platform/grafana" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('data',{}).get('admin-password',''))" \
  2>/dev/null || echo "")
if [ -z "$EXISTING_GRAFANA" ]; then
  GRAFANA_PASS=$(openssl rand -base64 20 | tr -d '=+/')
  GRAFANA_WRITE=$(curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/grafana" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\": {\"admin-user\": \"admin\", \"admin-password\": \"$GRAFANA_PASS\"}}")
  GRAFANA_VERSION=$(echo "$GRAFANA_WRITE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('version',''))" 2>/dev/null || echo "")
  if [ -n "$GRAFANA_VERSION" ]; then
    echo "==> Grafana secret written (randomly generated, version=$GRAFANA_VERSION)"
  else
    echo "⚠ Grafana write failed: $GRAFANA_WRITE"
    exit 1
  fi
else
  echo "==> Grafana secret already exists — preserving existing password"
fi

# ── Catalog app secrets — dynamic seeding via seed-catalog-secrets.sh ────────
#
# OLD APPROACH (removed): each catalog app had its own hardcoded block here
# (wiki, gitea, forgejo, vaultwarden). This was error-prone and required manual
# updates when apps were added or removed.
#
# NEW APPROACH: each catalog app declares its secret requirements in catalog.yaml
# under a `secrets:` section. seed-catalog-secrets.sh reads those declarations
# and idempotently seeds the required secrets into OpenBao.
#
# To add secrets for a new catalog app:
#   1. Add a `secrets:` section to kubernetes/catalog/<app>/catalog.yaml
#   2. Enable the app in platform.yaml
#   3. The next deploy will automatically seed the secrets
#
# The script is idempotent: existing values are NEVER overwritten.
echo ""
echo "==> Seeding catalog app secrets dynamically..."
OPENBAO_ADDR="${LOCAL_OPENBAO}" \
  VAULT_TOKEN="$ROOT_TOKEN" \
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" \
  bash "$(dirname "${BASH_SOURCE[0]}")/../seed-catalog-secrets.sh"
echo "==> Catalog secrets seeding complete"
echo ""

ARGOCD_ADMIN_PASS=$(kubectl --kubeconfig "$KB" get secret argocd-initial-admin-secret \
  -n argocd -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo "")
if [ -n "$ARGOCD_ADMIN_PASS" ]; then
  curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/argocd" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\": {\"admin-user\": \"admin\", \"admin-password\": \"$ARGOCD_ADMIN_PASS\"}}" > /dev/null
  echo "==> ArgoCD admin password stored in OpenBao (auto-generated by ArgoCD)"
else
  echo "==> argocd-initial-admin-secret not found — ArgoCD already configured"
fi

# ArgoCD remon: generate random password, apply bcrypt hash to argocd-secret, store in OpenBao
python3 -c "import bcrypt" 2>/dev/null || pip3 install --quiet bcrypt 2>/dev/null || sudo apt-get install -y python3-bcrypt -q 2>/dev/null || true
REMON_PASS=$(openssl rand -base64 20 | tr -d '=+/')
REMON_PASS_FILE=$(mktemp)
REMON_PATCH_FILE=$(mktemp)
printf '%s' "$REMON_PASS" > "$REMON_PASS_FILE"
python3 - "$REMON_PASS_FILE" "$REMON_PATCH_FILE" 2>/dev/null << 'REMON_PYEOF' || true
import bcrypt, json, sys
from datetime import datetime, timezone
with open(sys.argv[1]) as f:
    p = f.read().strip().encode()
h = bcrypt.hashpw(p, bcrypt.gensalt(10)).decode()
mtime = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'stringData': {'accounts.remon.password': h, 'accounts.remon.passwordMtime': mtime}}, open(sys.argv[2], 'w'))
REMON_PYEOF
if [ -s "$REMON_PATCH_FILE" ]; then
  kubectl --kubeconfig "$KB" patch secret argocd-secret -n argocd \
    --patch-file "$REMON_PATCH_FILE" 2>/dev/null || true
  curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/argocd-remon" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\": {\"user\": \"remon\", \"password\": \"$REMON_PASS\"}}" > /dev/null
  echo "==> ArgoCD remon password randomized and stored in OpenBao"
else
  echo "==> WARNING: bcrypt unavailable — remon password not set"
fi
rm -f "$REMON_PASS_FILE" "$REMON_PATCH_FILE"

# NetBird: generate random TURN relay password + datastore encryption key + setup key + PAT token
EXISTING_NETBIRD=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
  "${LOCAL_OPENBAO}/v1/secret/data/platform/netbird" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('data',{}).get('turn-password',''))" \
  2>/dev/null || echo "")
if [ -z "$EXISTING_NETBIRD" ]; then
  TURN_PASS=$(openssl rand -base64 24 | tr -d '=+/')
  DATASTORE_KEY=$(openssl rand -base64 32)
  # Generate valid 40-char NetBird PAT: nbp_ + 30 base62 chars + 6-char base62 CRC32 checksum
  NB_PAT=$(python3 -c 'import zlib,random,string; a=string.digits+string.ascii_uppercase+string.ascii_lowercase; b62=lambda n,s="": s if not n else b62(n//62,a[n%62]+s); t=next(s for s in iter(lambda:"".join(random.choices(a,k=30)),None) if len(b62(zlib.crc32(s.encode())&4294967295))==6); print("nbp_"+t+b62(zlib.crc32(t.encode())&4294967295))')
  # SETUP_KEY matches the hardcoded key in kubernetes/platform/netbird/manifests/bootstrap-job.yaml
  # It is written here so client DaemonSet pods can register via OpenBao ExternalSecret
  curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/netbird" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\": {\"turn-password\": \"$TURN_PASS\", \"datastore-enc-key\": \"$DATASTORE_KEY\", \"SETUP_KEY\": \"A1B2C3D4-E5F6-7890-ABCD-EF1234567890\", \"netbird-pat-token\": \"$NB_PAT\"}}" > /dev/null
  echo "==> NetBird secrets written (randomly generated, including PAT token)"
else
  echo "==> NetBird secrets already exist — preserving existing values"
fi

# Authentik: seed secret (script handles first-deploy and remon-password patch)
bash .github/scripts/seed-openbao-authentik.sh "$LOCAL_OPENBAO" "$ROOT_TOKEN"

# Authentik SMTP: always update OpenBao with real credentials from GitHub secrets
# (ESO ExternalSecret manages authentik-smtp-secret from these values)
if [ -n "${SMTP_PASSWORD}" ]; then
  EXISTING_DATA=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
    "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(__import__('json').dumps(d.get('data',{}).get('data',{})))" \
    2>/dev/null || echo "{}")
  SMTP_PATCHED=$(python3 -c \
    "import json,sys; d=json.loads(sys.argv[1]); d.update({'smtp-username':sys.argv[2],'smtp-password':sys.argv[3],'smtp-from':sys.argv[2]}); print(json.dumps({'data':d}))" \
    "$EXISTING_DATA" \
    "${SMTP_USERNAME}" \
    "${SMTP_PASSWORD}" \
    2>/dev/null || echo "")
  if [ -n "$SMTP_PATCHED" ]; then
    curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/authentik" \
      -H "X-Vault-Token: $ROOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$SMTP_PATCHED" > /dev/null
    echo "==> Authentik SMTP credentials updated in OpenBao"
  fi
else
  echo "⚠ SMTP_PASSWORD not set — authentik-smtp-secret will use placeholder"
fi

# GitHub PAT: optional — for console pipeline listing, pelican eggs, workflow dispatch.
# Does NOT overwrite an existing non-empty token (preserves manually rotated PATs).
if [ -n "${PLATFORM_GITHUB_PAT:-}" ]; then
  EXISTING_GH=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
    "${LOCAL_OPENBAO}/v1/secret/data/platform/infraweaver-console" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('data',{}).get('github-token',''))" \
    2>/dev/null || echo "")
  if [ -z "$EXISTING_GH" ]; then
    # Read-modify-write to preserve all other keys
    EXISTING_DATA=$(curl -s -H "X-Vault-Token: $ROOT_TOKEN" \
      "${LOCAL_OPENBAO}/v1/secret/data/platform/infraweaver-console" | \
      python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('data',{}).get('data',{})))" \
      2>/dev/null || echo "{}")
    PATCHED=$(python3 -c "
import json,sys
d=json.loads(sys.argv[1]); d['github-token']=sys.argv[2]
print(json.dumps({'data':d}))
" "$EXISTING_DATA" "$PLATFORM_GITHUB_PAT")
    curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/infraweaver-console" \
      -H "X-Vault-Token: $ROOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PATCHED" > /dev/null
    echo "==> GitHub token stored in OpenBao (platform/infraweaver-console[github-token])"
  else
    echo "==> GitHub token already exists in OpenBao — preserving existing value"
  fi
else
  echo "==> GITHUB_PAT not set — console pipeline/pelican features will be unavailable (optional; set GITHUB_PAT secret in repo settings)"
fi

# Cloudflare: store API token from GitHub secret (idempotent, always refresh)
if [ -n "${CLOUDFLARE_API_TOKEN}" ]; then
  curl -s -X POST "${LOCAL_OPENBAO}/v1/secret/data/platform/cloudflare" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\": {\"CF_API_TOKEN\": \"${CLOUDFLARE_API_TOKEN}\", \"CF_EMAIL\": \"remonhulst@gmail.com\"}}" > /dev/null
  echo "==> Cloudflare token stored in OpenBao (platform/cloudflare)"
else
  echo "⚠ CLOUDFLARE_API_TOKEN secret not set — cert-manager DNS-01 will fail"
fi

          # Write least-privilege policy for ESO (use env to properly pass VAULT_TOKEN/VAULT_ADDR)
kubectl --kubeconfig "$KB" exec -n openbao openbao-0 -- \
  env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 sh -c \
  'bao policy write platform-k8s - <<EOF
path "secret/data/platform/*" { capabilities = ["read","list"] }
path "secret/metadata/platform/*" { capabilities = ["read","list"] }
path "secret/data/infraweaver/*" { capabilities = ["read","list","create","update","delete"] }
path "secret/metadata/infraweaver/*" { capabilities = ["read","list","create","update","delete"] }
EOF'
echo "==> ESO policy platform-k8s written"

# Tune token auth to allow long-lived tokens (use bao CLI)
kubectl --kubeconfig "$KB" exec -n openbao openbao-0 -- \
  env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 \
  bao auth tune -max-lease-ttl=87600h token/ 2>/dev/null || true

# Create ESO service token — periodic (30-day period), ESO auto-renews it.
# Periodic tokens expire if not renewed within the period, which is the
# correct security posture: a compromised token self-destructs within 30 days.
# ESO renews tokens automatically as long as it's running.
# 30 days (720h) provides a larger safety buffer vs the 7-day original:
# during planned maintenance/upgrades ESO may restart and need time to re-acquire the token.
SERVICE_TOKEN=$(kubectl --kubeconfig "$KB" exec -n openbao openbao-0 -- \
  env VAULT_TOKEN="$ROOT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 bao token create \
    -policy=platform-k8s \
    -policy=default \
    -period=720h \
    -orphan \
    -display-name="eso-${ENV}-periodic" \
    -renewable=true \
    -format=json 2>/dev/null | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['client_token'])" \
  2>/dev/null || echo "")

if [ -z "$SERVICE_TOKEN" ]; then
  echo "⚠ Could not create ESO service token — skipping"
  kill $PF_PID 2>/dev/null || true
  exit 0
fi

# Close port-forward before kubectl operations
kill $PF_PID 2>/dev/null || true

# Store the ESO service token in a k8s secret so local deploys can retrieve it
# (GitHub Actions reads it from GITHUB_ENV; local deploys read from this secret)
kubectl --kubeconfig "$KB" create namespace external-secrets --dry-run=client -o yaml \
  | kubectl --kubeconfig "$KB" apply -f - 2>/dev/null || true
kubectl --kubeconfig "$KB" create secret generic openbao-eso-token \
  -n kube-system \
  --from-literal=token="${SERVICE_TOKEN}" \
  --dry-run=client -o yaml | kubectl --kubeconfig "$KB" apply -f -
echo "==> ESO service token stored in k8s secret (kube-system/openbao-eso-token)"

# Export for GitHub Actions (if running in CI)
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "ESO_SERVICE_TOKEN=${SERVICE_TOKEN}" >> "$GITHUB_ENV"
  echo "OPENBAO_CLUSTER_ADDR=http://openbao.openbao.svc.cluster.local:8200" >> "$GITHUB_ENV"
fi

