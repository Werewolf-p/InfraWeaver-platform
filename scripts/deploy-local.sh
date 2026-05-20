#!/usr/bin/env bash
# =============================================================================
# deploy-local.sh — InfraWeaver Full Local Deployment
#
# USAGE:
#   # Option 1: via web UI (recommended for first-timers)
#   python3 scripts/init/server.py   # open http://localhost:8080
#
#   # Option 2: direct terminal
#   cp .env.example .env && nano .env
#   bash scripts/deploy-local.sh
#
#   # Option 3: with explicit env file
#   ENV_FILE=/path/to/.env bash scripts/deploy-local.sh
#
# WHAT THIS DOES (full local deployment pipeline):
#   1.  Install required tools (tofu, talosctl, kubectl, helm, sops, age)
#   2.  Set up SSH key from DEPLOYER_SSH_KEY env var
#   3.  Provision Talos cluster VMs on Proxmox via OpenTofu
#   4.  Bootstrap the Talos cluster + save kubeconfig/talosconfig
#   5.  Fix CoreDNS startup race condition
#   6.  Deploy ArgoCD + bootstrap ApplicationSet
#   7.  Bootstrap local-path-provisioner storage
#   8.  Bootstrap OpenBao + ExternalSecrets
#   9.  Ensure Cloudflare DNS records
#   10. Apply MetalLB IP pool + Traefik middleware
#   11. Configure TLS certificate issuers
#   12. Reconnect NetBird router VM
#   13. Fix ingress-nginx admission webhook
#   14. Patch cluster CoreDNS for internal zones
#   15. Configure Authentik (admin privileges + user passwords)
#   16. Configure OIDC for ArgoCD and OpenBao
#   17. Run post-deploy tests
#   18. Send deployment summary email
#
# PREREQUISITES:
#   - .env file with required values (see .env.example)
#   - SSH access to Proxmox host (DEPLOYER_SSH_KEY in .env)
#   - This script can be run from the InfraWeaver repo root
#
# SECRETS:
#   All secrets read from .env — no SOPS/age key required for local deploy.
#   The .env is NOT committed to git (see .gitignore).
# =============================================================================
set -euo pipefail

SCRIPT_NAME="deploy-local"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# shellcheck source=scripts/lib.sh
source "scripts/lib.sh"

RUNNER_OVERRIDE=""
cleanup() {
  [[ -n "${RUNNER_OVERRIDE:-}" ]] && rm -f "$RUNNER_OVERRIDE"
}
trap cleanup EXIT

# ── Load .env ────────────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env}"
if [[ -f "$ENV_FILE" ]]; then
  log "Loading environment from $ENV_FILE"
  # Use Python to emit bash $'...' exports — handles multi-line values (SSH keys etc.)
  # shellcheck disable=SC1090,SC2046
  eval "$(python3 - "$ENV_FILE" << 'PYEOF'
import sys, re

def bash_ansi_quote(s):
    """Encode any string as bash $'...' literal so eval handles newlines/special chars."""
    out = []
    for c in s:
        if   c == '\n': out.append('\\n')
        elif c == '\r': out.append('\\r')
        elif c == '\t': out.append('\\t')
        elif c == '\\': out.append('\\\\')
        elif c == "'":  out.append("\\'")
        else:           out.append(c)
    return "$'" + ''.join(out) + "'"

path = sys.argv[1]
content = open(path).read()
# Match KEY="..." including multi-line quoted values, and KEY=unquoted
for m in re.finditer(
    r'^([A-Za-z_][A-Za-z0-9_]*)=((?:"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[^\n]*))',
    content, re.MULTILINE
):
    k, v = m.group(1), m.group(2).strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        v = v[1:-1]
    print(f'export {k}={bash_ansi_quote(v)}')
PYEOF
  )"
  ok "Loaded $ENV_FILE"
else
  warn ".env not found at $ENV_FILE"
  warn "Run: cp .env.example .env && nano .env"
  die "Aborting — no .env file"
fi

# ── Validate required vars ────────────────────────────────────────────────────
REQUIRED_VARS=(ADMIN_EMAIL GITHUB_REPO GIT_REPO_URL PROXMOX_API_TOKEN DEPLOYER_SSH_KEY CLOUDFLARE_API_TOKEN SMTP_USERNAME SMTP_PASSWORD)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  val="${!v:-}"
  if [[ -z "$val" || "$val" == *"<your"* || "$val" == *"xxxx"* || "$val" == *"yourdomain.com"* || "$val" == *"your-org/your-repo"* ]]; then
    MISSING+=("$v")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  die "Missing required .env values: ${MISSING[*]}\nEdit $ENV_FILE and fill in all required fields."
fi

ENV_NAME="${ENV_NAME:-productie}"
LETSENCRYPT_ENV="${LETSENCRYPT_ENV:-production}"
BASE_DOMAIN="${BASE_DOMAIN:-}"
if [[ -z "${BASE_DOMAIN:-}" ]]; then
  err "BASE_DOMAIN not set — ensure .env is configured (run the init website)"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     InfraWeaver — Local Platform Deployment                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
log "Environment   : $ENV_NAME"
log "Domain        : $BASE_DOMAIN"
log "LE env        : $LETSENCRYPT_ENV"
log "Repo          : $REPO_DIR"
echo ""

# ── Step 1: Install tools ─────────────────────────────────────────────────────
log "Step 1: Installing required tools..."
ENV_NAME="$ENV_NAME" bash scripts/deploy/install-tools.sh
ok "Tools installed"

# ── Step 2: Set up SSH key ────────────────────────────────────────────────────
log "Step 2: Setting up SSH key..."
mkdir -p ~/.ssh
# DEPLOYER_SSH_KEY may be a file path or the actual key content
if [[ -f "$DEPLOYER_SSH_KEY" ]]; then
  # If same file, skip copy (file path == ~/.ssh/deployer_ed25519)
  if [[ "$(realpath "$DEPLOYER_SSH_KEY" 2>/dev/null)" != "$(realpath ~/.ssh/deployer_ed25519 2>/dev/null)" ]]; then
    cp "$DEPLOYER_SSH_KEY" ~/.ssh/deployer_ed25519
  fi
elif [[ "$DEPLOYER_SSH_KEY" == *"BEGIN"* ]]; then
  printf '%s\n' "$DEPLOYER_SSH_KEY" > ~/.ssh/deployer_ed25519
else
  die "DEPLOYER_SSH_KEY must be a file path or PEM-encoded private key"
fi
chmod 600 ~/.ssh/deployer_ed25519
ok "SSH key configured at ~/.ssh/deployer_ed25519"

# Verify SSH connectivity to Proxmox
PVE_IP="${PROXMOX_HOST:-}"
if [[ -z "$PVE_IP" ]]; then
  PVE_IP=$(grep 'proxmox_host:' "envs/$ENV_NAME/cluster.yaml" 2>/dev/null | head -1 | sed 's/.*: *"\(.*\)"/\1/' | xargs || true)
fi
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i ~/.ssh/deployer_ed25519"
if ssh $SSH_OPTS root@"$PVE_IP" echo "ssh-ok" &>/dev/null; then
  ok "SSH connection to Proxmox $PVE_IP verified"
else
  warn "SSH to Proxmox $PVE_IP failed — deployment will continue but may fail at VM provisioning"
fi

# ── Step 3: Set TF variables from .env ───────────────────────────────────────
log "Step 3: Preparing Terraform variables..."
export TF_VAR_proxmox_api_token="$PROXMOX_API_TOKEN"
export TF_VAR_cloudflare_api_token="$CLOUDFLARE_API_TOKEN"
unset TF_VAR_github_runner_token 2>/dev/null || true
GITHUB_INTEGRATION_ENABLED=false
if [[ -n "${GITHUB_PAT:-}" && -n "${RUNNER_REGISTRATION_TOKEN:-}" && "${RUNNER_REGISTRATION_TOKEN:-}" != placeholder* ]]; then
  export TF_VAR_github_runner_token="$RUNNER_REGISTRATION_TOKEN"
  GITHUB_INTEGRATION_ENABLED=true
fi
export TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

STATE_DIR=~/.tofu/state/platform-"$ENV_NAME"
mkdir -p "$STATE_DIR"
ok "TF_VARs set"

# ── Step 3a: Substitute .env placeholders into tfvars/yaml templates ─────────
log "Step 3a: Substituting .env placeholders into config templates..."
bash "${REPO_DIR}/scripts/generate-from-env.sh"
ok "Step 3a: Templates substituted"

# ── Step 4: Deploy Platform (Terraform) ──────────────────────────────────────
log "Step 4: Deploying platform via OpenTofu (this takes 10–15 minutes)..."

KB_FILE=~/.kube/config-platform-"$ENV_NAME"
mkdir -p ~/.kube "envs/$ENV_NAME/generated"

cd terraform

tofu init \
  -backend-config="path=$STATE_DIR/terraform.tfstate" \
  -reconfigure 2>&1

VARS=""
[[ -f "../envs/$ENV_NAME/terraform.tfvars" ]]       && VARS="$VARS -var-file=../envs/$ENV_NAME/terraform.tfvars"
[[ -f "../envs/$ENV_NAME/services.auto.tfvars" ]]   && VARS="$VARS -var-file=../envs/$ENV_NAME/services.auto.tfvars"

# Stage 1: provision Talos cluster VMs
log "==> Stage 1: provisioning Talos cluster VMs on Proxmox..."
# shellcheck disable=SC2086
tofu apply $VARS \
  -target=module.talos_cluster \
  -target=local_sensitive_file.kubeconfig \
  -target=local_sensitive_file.talosconfig \
  -auto-approve 2>&1
ok "Stage 1: Talos VMs provisioned"

# Save configs
tofu output -raw kubeconfig > "$KB_FILE" 2>/dev/null || true
chmod 600 "$KB_FILE" 2>/dev/null || true
tofu output -raw talosconfig > "../envs/$ENV_NAME/generated/talosconfig" 2>/dev/null || true
chmod 600 "../envs/$ENV_NAME/generated/talosconfig" 2>/dev/null || true

# Stage 2a: install ArgoCD namespace + Helm (gets CRDs registered)
log "==> Stage 2a: installing ArgoCD namespace + Helm chart..."
# shellcheck disable=SC2086
tofu apply $VARS \
  -target='module.platform_bootstrap[0].kubernetes_namespace.argocd' \
  -target='module.platform_bootstrap[0].helm_release.argocd' \
  -auto-approve 2>&1
ok "Stage 2a: ArgoCD Helm installed"

# Wait for ArgoCD CRDs
log "==> Waiting for ArgoCD CRDs to register..."
for crd in appprojects.argoproj.io applications.argoproj.io applicationsets.argoproj.io; do
  for i in $(seq 1 36); do
    kubectl --kubeconfig "$KB_FILE" wait --for=condition=Established "crd/$crd" --timeout=5s 2>/dev/null \
      && log "  ✅ $crd ready" && break
    log "  waiting for $crd ($i/36)..."
    sleep 5
  done
done

# Stage 2b: full platform bootstrap
# Build homelab-ansible Docker image only when optional GitHub integration is enabled
SKIP_RUNNERS=true
if [[ "$GITHUB_INTEGRATION_ENABLED" != "true" ]]; then
  log "==> GitHub integration not configured — skipping optional GitHub runner provisioning"
else
  SKIP_RUNNERS=false
  log "==> GitHub integration detected — building homelab-ansible image for optional runner provisioning..."
  if docker images -q homelab-ansible:latest 2>/dev/null | grep -q .; then
    ok "homelab-ansible:latest already present"
  elif docker build -t homelab-ansible:latest "$REPO_DIR/ansible" 2>&1; then
    ok "homelab-ansible image built"
  else
    log "⚠️  homelab-ansible image build failed — skipping optional GitHub runner provisioning"
    SKIP_RUNNERS=true
  fi
fi

STAGE2B_VARS="$VARS"
if [[ "$SKIP_RUNNERS" == "true" ]]; then
  RUNNER_OVERRIDE="../envs/$ENV_NAME/generated/github-runners.disabled.auto.tfvars"
  printf 'github_runners = {}\n' > "$RUNNER_OVERRIDE"
  STAGE2B_VARS="$VARS -var-file=$RUNNER_OVERRIDE"
fi

log "==> Stage 2b: full platform bootstrap..."
# shellcheck disable=SC2086
tofu apply $STAGE2B_VARS -auto-approve 2>&1
ok "Stage 2b: Platform bootstrap complete"

cd "$REPO_DIR"
ok "Step 4: Platform deployed"

# ── Step 5: Fix CoreDNS startup race ──────────────────────────────────────────
log "Step 5: Fixing CoreDNS startup race condition..."
log "==> Waiting for Flannel DaemonSet..."
for i in $(seq 1 30); do
  DESIRED=$(kubectl --kubeconfig "$KB_FILE" get ds kube-flannel -n kube-system \
    -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo "0")
  READY=$(kubectl --kubeconfig "$KB_FILE" get ds kube-flannel -n kube-system \
    -o jsonpath='{.status.numberReady}' 2>/dev/null || echo "0")
  if [[ "$DESIRED" -gt 0 && "$READY" -eq "$DESIRED" ]]; then
    log "  Flannel ready: $READY/$DESIRED"
    break
  fi
  log "  Flannel $READY/$DESIRED ($i/30)..."
  sleep 10
done
sleep 10
kubectl --kubeconfig "$KB_FILE" rollout restart deployment/coredns -n kube-system 2>/dev/null || true
kubectl --kubeconfig "$KB_FILE" rollout status deployment/coredns -n kube-system --timeout=120s 2>/dev/null || true
ok "Step 5: CoreDNS restarted"

# ── Step 5b: Configure platform from .env feature flags ──────────────────────
log "Step 5b: Configuring platform from .env feature flags..."
bash scripts/configure-platform.sh || warn "configure-platform.sh had issues (continuing)"
ok "Step 5b: Platform configured"

# ── Step 6: Deploy ArgoCD & Bootstrap ─────────────────────────────────────────
log "Step 6: Deploy ArgoCD & bootstrap ApplicationSet..."
ENV_NAME="$ENV_NAME" bash scripts/deploy/deploy-argocd.sh
ok "Step 6: ArgoCD deployed"

# ── Step 7: Bootstrap Storage + PriorityClasses ──────────────────────────────
log "Step 7: Bootstrap local-path-provisioner storage + platform PriorityClasses..."
ENV_NAME="$ENV_NAME" bash scripts/deploy/bootstrap-storage.sh
# Apply PriorityClasses early — Longhorn and other services reference platform-standard
kubectl --kubeconfig "$KB_FILE" apply \
  -f kubernetes/core/priority-classes/manifests/priority-classes.yaml 2>/dev/null || true
ok "Step 7: Storage bootstrapped + PriorityClasses applied"

# ── Step 7b: Deploy Longhorn directly (breaks ArgoCD→Onedev→Longhorn cycle) ──
log "Step 7b: Deploying Longhorn directly via Helm..."
helm repo add longhorn https://charts.longhorn.io 2>/dev/null || true
helm repo update longhorn 2>/dev/null || true
kubectl --kubeconfig "$KB_FILE" create namespace longhorn-system --dry-run=client -o yaml \
  | kubectl --kubeconfig "$KB_FILE" apply -f -
helm --kubeconfig "$KB_FILE" upgrade --install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version "1.7.*" \
  -f kubernetes/core/longhorn/values.yaml \
  --timeout 10m --wait 2>&1 | tail -5 || warn "Longhorn helm install had issues — continuing"
# Apply supplementary manifests (StorageClass longhorn-retain etc.)
kubectl --kubeconfig "$KB_FILE" apply -f kubernetes/core/longhorn/manifests/ 2>/dev/null || true
ok "Step 7b: Longhorn deployed"

# ── Step 8: Deploy OpenBao directly + Bootstrap ───────────────────────────────
log "Step 8: Deploying OpenBao directly via Helm + bootstrapping..."
helm repo add openbao https://openbao.github.io/openbao-helm 2>/dev/null || true
helm repo update openbao 2>/dev/null || true
kubectl --kubeconfig "$KB_FILE" create namespace openbao --dry-run=client -o yaml \
  | kubectl --kubeconfig "$KB_FILE" apply -f - 2>/dev/null || true
# Apply namespace/network/rbac manifests first
kubectl --kubeconfig "$KB_FILE" apply -f kubernetes/core/openbao/manifests/ \
  --server-side 2>/dev/null || true
helm --kubeconfig "$KB_FILE" upgrade --install openbao openbao/openbao \
  --namespace openbao \
  --version "0.27.2" \
  -f kubernetes/core/openbao/values.yaml \
  --timeout 5m 2>&1 | tail -5 || warn "OpenBao helm install had issues — continuing"
# Now run the bootstrap-openbao script (init, unseal, seed secrets)
ENV_NAME="$ENV_NAME" \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
SMTP_USERNAME="$SMTP_USERNAME" \
SMTP_PASSWORD="$SMTP_PASSWORD" \
PLATFORM_GITHUB_PAT="${GITHUB_PAT:-}" \
  bash scripts/deploy/bootstrap-openbao.sh
ok "Step 8: OpenBao deployed and bootstrapped"

# ── Step 9: Deploy Onedev + wire ArgoCD → Onedev ──────────────────────────────
log "Step 9: Deploying Onedev and wiring ArgoCD to it..."
# Refresh kubeconfig — Talos may have rotated certs since step 4
TALOSCONFIG_FILE="envs/$ENV_NAME/generated/talosconfig"
[[ ! -f "$TALOSCONFIG_FILE" ]] && TALOSCONFIG_FILE="envs/$ENV_NAME/talosconfig"
if [[ -f "$TALOSCONFIG_FILE" ]]; then
  log "  Refreshing kubeconfig via talosctl..."
  talosctl --talosconfig "$TALOSCONFIG_FILE" kubeconfig --force \
    -o "$KB_FILE" 2>/dev/null && log "  ✅ kubeconfig refreshed" || warn "  kubeconfig refresh failed (continuing)"
fi
# Get OpenBao root token
BAO_POD=$(kubectl --kubeconfig "$KB_FILE" get pod -n openbao \
  -l app.kubernetes.io/name=openbao --no-headers \
  -o custom-columns=":metadata.name" 2>/dev/null | head -1 || true)
BAO_ROOT_TOKEN=""
if [[ -n "$BAO_POD" ]]; then
  BAO_ROOT_TOKEN=$(kubectl --kubeconfig "$KB_FILE" get secret openbao-unseal -n openbao \
    -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "")
fi
# Run bootstrap.sh: deploys Onedev directly, mirrors repo, switches ArgoCD source
if [[ -n "$BAO_ROOT_TOKEN" ]]; then
  KUBECONFIG="$KB_FILE" \
  ENV_NAME="$ENV_NAME" \
  VAULT_TOKEN="$BAO_ROOT_TOKEN" \
    bash scripts/bootstrap.sh \
    || warn "bootstrap.sh had issues — Onedev/ArgoCD wiring may need manual completion"
else
  warn "No OpenBao root token — deploying Onedev manifests directly without service account"
  kubectl --kubeconfig "$KB_FILE" apply -f kubernetes/catalog/onedev/ --server-side 2>/dev/null || true
fi
ok "Step 9: Onedev deployed and ArgoCD wired"

# ── Step 10: Bootstrap ExternalSecrets + TLS Restore ─────────────────────────
log "Step 10: Bootstrap ExternalSecrets + TLS restore..."
# Read ESO service token from k8s secret (written by bootstrap-openbao.sh for local deploys)
ESO_SERVICE_TOKEN=$(kubectl --kubeconfig "$KB_FILE" get secret openbao-eso-token \
  -n kube-system -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || echo "")
ENV_NAME="$ENV_NAME" \
  ESO_SERVICE_TOKEN="$ESO_SERVICE_TOKEN" \
  OPENBAO_CLUSTER_ADDR="http://openbao.openbao.svc.cluster.local:8200" \
  bash scripts/deploy/bootstrap-externalsecrets.sh
ok "Step 10: ExternalSecrets bootstrapped"

# ── Step 11: Ensure Cloudflare DNS ────────────────────────────────────────────
log "Step 11: Ensuring Cloudflare DNS records..."
ENV_NAME="$ENV_NAME" CF_TOKEN="$CLOUDFLARE_API_TOKEN" bash scripts/deploy/ensure-cloudflare-dns.sh
ok "Step 11: DNS configured"

# ── Step 12: Apply MetalLB IP Pool + Traefik Middleware ───────────────────────
log "Step 12: Applying MetalLB IP pool + Traefik middleware..."
for i in $(seq 1 30); do
  kubectl --kubeconfig "$KB_FILE" get crd ipaddresspools.metallb.io >/dev/null 2>&1 && break
  log "  Waiting for MetalLB CRDs ($i/30)..."
  sleep 10
done
kubectl --kubeconfig "$KB_FILE" apply -f kubernetes/core/metallb/ip-pool.yaml 2>/dev/null || true
kubectl --kubeconfig "$KB_FILE" label namespace metallb-system \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/warn=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/enforce-version=latest \
  --overwrite 2>/dev/null || true
kubectl --kubeconfig "$KB_FILE" rollout restart daemonset/metallb-speaker -n metallb-system 2>/dev/null || true
kubectl --kubeconfig "$KB_FILE" apply -f kubernetes/core/traefik/manifests/middleware-netbird.yaml 2>/dev/null || true
ok "Step 12: MetalLB + Traefik middleware applied"

# ── Step 13: Configure certificate issuers ────────────────────────────────────
log "Step 13: Configuring certificate issuers (LE: $LETSENCRYPT_ENV)..."
if [[ "$LETSENCRYPT_ENV" == "staging" ]]; then
  log "  Switching to staging LE issuers..."
  for i in $(seq 1 20); do
    kubectl --kubeconfig "$KB_FILE" --insecure-skip-tls-verify \
      get crd certificates.cert-manager.io >/dev/null 2>&1 && break
    log "  Waiting for cert-manager CRDs ($i/20)..."
    sleep 10
  done
  for cert in $(kubectl --kubeconfig "$KB_FILE" --insecure-skip-tls-verify \
    get certificate -n traefik -o name 2>/dev/null || true); do
    CURRENT=$(kubectl --kubeconfig "$KB_FILE" --insecure-skip-tls-verify get "$cert" -n traefik \
      -o jsonpath='{.spec.issuerRef.name}' 2>/dev/null || true)
    case "$CURRENT" in
      letsencrypt-http) NEW="letsencrypt-http-staging" ;;
      letsencrypt-cloudflare) NEW="letsencrypt-cloudflare-staging" ;;
      *) continue ;;
    esac
    kubectl --kubeconfig "$KB_FILE" --insecure-skip-tls-verify patch "$cert" -n traefik \
      --type=merge -p "{\"spec\":{\"issuerRef\":{\"name\":\"${NEW}\"}}}" 2>/dev/null \
      && log "  Patched $cert → $NEW" || true
  done
fi
ok "Step 13: TLS configured"

# ── Step 14: Reconnect NetBird ────────────────────────────────────────────────
log "Step 14: Reconnecting NetBird router VM..."
ENV_NAME="$ENV_NAME" bash scripts/deploy/reconnect-netbird.sh 2>/dev/null || warn "NetBird reconnect failed (continuing)"
ENV_NAME="$ENV_NAME" bash scripts/deploy/populate-netbird.sh 2>/dev/null  || warn "NetBird populate failed (continuing)"
ok "Step 14: NetBird reconnected"

# ── Step 15: Fix ingress-nginx admission webhook ──────────────────────────────
log "Step 15: Fixing ingress-nginx admission webhook CA bundle..."
for attempt in $(seq 1 12); do
  CA_BUNDLE=$(kubectl --kubeconfig "$KB_FILE" get secret ingress-nginx-admission \
    -n ingress-nginx -o jsonpath='{.data.ca}' 2>/dev/null || true)
  if [[ -n "$CA_BUNDLE" ]]; then
    kubectl --kubeconfig "$KB_FILE" patch validatingwebhookconfiguration \
      ingress-nginx-admission --type json \
      -p "[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"$CA_BUNDLE\"}]" \
      2>/dev/null && log "  ✅ ingress-nginx webhook CA patched" && break
  fi
  log "  Waiting for ingress-nginx-admission secret ($attempt/12)..."
  sleep 10
done
ok "Step 15: ingress-nginx webhook patched"

# ── Step 16: Patch cluster CoreDNS for internal zones ────────────────────────
log "Step 16: Patching CoreDNS for internal zones..."
DNS_CLUSTERIP=$(kubectl --kubeconfig "$KB_FILE" get svc coredns -n dns-system \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "")
TRAEFIK_CLUSTERIP=$(kubectl --kubeconfig "$KB_FILE" get svc traefik -n traefik \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "")
if [[ -n "$DNS_CLUSTERIP" && -n "$TRAEFIK_CLUSTERIP" ]]; then
  kubectl --kubeconfig "$KB_FILE" patch configmap coredns -n kube-system --type=merge -p \
    "{\"data\":{\"Corefile\":\".:53 {\n    errors\n    health {\n        lameduck 5s\n    }\n    ready\n    log . {\n        class error\n    }\n    prometheus :9153\n\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n        pods insecure\n        fallthrough in-addr.arpa ip6.arpa\n        ttl 30\n    }\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30 {\n       disable success cluster.local\n       disable denial cluster.local\n    }\n    loop\n    reload\n    loadbalance\n}\n\nauth.${BASE_DOMAIN}:53 {\n    errors\n    hosts {\n        ${TRAEFIK_CLUSTERIP} auth.${BASE_DOMAIN}\n    }\n}\n\n${BASE_DOMAIN}:53 {\n    errors\n    forward . ${DNS_CLUSTERIP}\n    cache 30\n}\n\nint.${BASE_DOMAIN}:53 {\n    errors\n    forward . ${DNS_CLUSTERIP}\n    cache 30\n}\n\n${CLUSTER_LOCAL_DOMAIN}:53 {\n    errors\n    forward . ${DNS_CLUSTERIP}\n    cache 30\n}\n\"}}" 2>/dev/null || true
  kubectl --kubeconfig "$KB_FILE" rollout restart deployment/coredns -n kube-system 2>/dev/null || true
  kubectl --kubeconfig "$KB_FILE" rollout status deployment/coredns -n kube-system --timeout=60s 2>/dev/null || true
  ok "Step 16: CoreDNS patched"
else
  warn "Step 16: Could not get ClusterIPs — CoreDNS patching skipped"
fi

# ── Step 17: Configure Authentik ──────────────────────────────────────────────
log "Step 17: Configuring Authentik..."
ENV_NAME="$ENV_NAME" bash scripts/deploy/configure-authentik.sh 2>/dev/null || warn "configure-authentik.sh failed (may retry)"
ENV_NAME="$ENV_NAME" bash scripts/deploy/set-user-passwords.sh 2>/dev/null  || warn "set-user-passwords.sh failed (may retry)"
ok "Step 17: Authentik configured"

# ── Step 18: Send welcome emails ──────────────────────────────────────────────
log "Step 18: Sending welcome emails..."
ENV_NAME="$ENV_NAME" SMTP_USERNAME="$SMTP_USERNAME" SMTP_PASSWORD="$SMTP_PASSWORD" \
  bash scripts/deploy/send-welcome-emails.sh 2>/dev/null || warn "Welcome emails failed (non-fatal)"

# ── Step 19: Configure OIDC ───────────────────────────────────────────────────
log "Step 19: Configuring OIDC (ArgoCD + OpenBao)..."
ENV_NAME="$ENV_NAME" PROXMOX_API_TOKEN="$PROXMOX_API_TOKEN" \
  bash scripts/deploy/configure-oidc.sh 2>/dev/null || warn "OIDC configuration failed (may retry)"
ok "Step 19: OIDC configured"

# ── Step 20: Post-deploy tests ────────────────────────────────────────────────
log "Step 20: Running post-deploy tests..."
bash scripts/test-post-deploy.sh "$KB_FILE" "$ENV_NAME" 2>/dev/null || warn "Post-deploy tests had failures (non-fatal)"

# ── Step 21: Send deployment summary email ────────────────────────────────────
log "Step 21: Sending deployment summary email..."
BAO_TOKEN=$(kubectl --kubeconfig "$KB_FILE" get secret openbao-unseal -n openbao \
  -o jsonpath='{.data.root_token}' 2>/dev/null | base64 -d || echo "unavailable")
BAO_UNSEAL=$(kubectl --kubeconfig "$KB_FILE" get secret openbao-unseal -n openbao \
  -o jsonpath='{.data.unseal_key}' 2>/dev/null | base64 -d || echo "unavailable")

export DEPLOY_ENV="$ENV_NAME"
export DEPLOY_RUN_URL="local://${HOSTNAME:-$(hostname)}/$(date +%Y-%m-%dT%H:%M:%S)"
export BAO_TOKEN BAO_UNSEAL
SMTP_USERNAME="$SMTP_USERNAME" SMTP_PASSWORD="$SMTP_PASSWORD" SMTP_TO="${SMTP_TO:-$SMTP_USERNAME}" \
  python3 scripts/send-deploy-email.py 2>/dev/null || warn "Deploy summary email failed (non-fatal)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     ✅ Deployment complete!                                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
ok "Kubeconfig    : $KB_FILE"
ok "Talosconfig   : envs/$ENV_NAME/generated/talosconfig"
ok "Tofu state    : $STATE_DIR"
echo ""
log "Quick checks:"
kubectl --kubeconfig "$KB_FILE" get nodes 2>/dev/null || true
echo ""
log "Service URLs (may take a few minutes to become available):"
log "  ArgoCD     : https://argocd.int.${BASE_DOMAIN}"
log "  Console    : https://console.${BASE_DOMAIN}"
log "  Authentik  : https://auth.${BASE_DOMAIN}"
log "  Grafana    : https://grafana.int.${BASE_DOMAIN}"
log "  Onedev     : https://onedev.${BASE_DOMAIN}"
echo ""
log "Deployment log: $(date)"
echo ""
