#!/usr/bin/env bash
# scripts/update.sh — Pull latest InfraWeaver platform updates from GitHub
# Usage: ./scripts/update.sh [--skip-rebuild] [--json]
#
# This script updates the init-VM's local copy of the platform repo from the
# official GitHub repository. Kubernetes apps (api/console/node) update
# automatically via ArgoCD when image tags change in the manifests.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITHUB_URL="https://github.com/Werewolf-p/InfraWeaver-platform.git"
JSON_OUTPUT=false
SKIP_REBUILD=false

for arg in "$@"; do
  case $arg in
    --json)         JSON_OUTPUT=true ;;
    --skip-rebuild) SKIP_REBUILD=true ;;
  esac
done

log()  { "$JSON_OUTPUT" || echo "[update] $*"; }
jout() { "$JSON_OUTPUT" && echo "$*"; }
run_update_cmd() {
  if [ "$JSON_OUTPUT" = "true" ]; then
    "$@" >/dev/null 2>&1
  else
    "$@" 2>&1
  fi
}

cd "$REPO_DIR"

# 1. Capture pre-update state
OLD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
INIT_SITE_DIR="$REPO_DIR/apps/infraweaver-init"
INIT_OUT_DIR="$REPO_DIR/scripts/init/out"

log "Current commit: $OLD_SHA"

# 2. Ensure github remote exists
if ! git remote get-url github &>/dev/null; then
  git remote add github "$GITHUB_URL"
  log "Added github remote: $GITHUB_URL"
fi

log "Fetching latest from GitHub..."
run_update_cmd git fetch --quiet github main || {
  log "GitHub fetch failed — falling back to origin (Onedev)"
  run_update_cmd git fetch --quiet origin main || { log "All fetches failed"; exit 1; }
  git remote set-head github -a 2>/dev/null || true
}

REMOTE_SHA=$(git rev-parse github/main 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo "")

if [ "$OLD_SHA" = "$REMOTE_SHA" ]; then
  log "Already up to date ($OLD_SHA)."
  jout "{\"ok\":true,\"updated\":false,\"sha\":\"$OLD_SHA\",\"message\":\"Already up to date\",\"machineConfigApplied\":false}"
  exit 0
fi

# 3. Pull from GitHub
log "Pulling $OLD_SHA → $REMOTE_SHA..."
run_update_cmd git pull --ff-only github main || {
  log "Fast-forward failed — trying merge"
  run_update_cmd git merge github/main --no-edit || {
    log "Merge failed"
    jout "{\"ok\":false,\"error\":\"git merge github/main failed\"}"
    exit 1
  }
}
NEW_SHA=$(git rev-parse HEAD)

# 4. Collect changelog
CHANGELOG=$(git log --oneline --no-merges "${OLD_SHA}..${NEW_SHA}" 2>/dev/null || echo "")
log "New commits:"
echo "$CHANGELOG" | while read -r line; do log "  $line"; done

# 5. Rebuild init site if its source changed
INIT_REBUILT=false
if [ "$SKIP_REBUILD" = "false" ]; then
  INIT_CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA" -- apps/infraweaver-init/ 2>/dev/null | wc -l)
  SERVER_CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA" -- scripts/init/server.py 2>/dev/null | wc -l)

  if [ "$INIT_CHANGED" -gt 0 ] || [ "$SERVER_CHANGED" -gt 0 ]; then
    log "Init site source changed ($INIT_CHANGED files), rebuilding..."
    if command -v node &>/dev/null && [ -f "$INIT_SITE_DIR/package.json" ]; then
      run_update_cmd timeout 300 bash -c "cd '$INIT_SITE_DIR' && npm ci --prefer-offline --loglevel error && npm run build" || {
        log "Init site build failed — continuing without rebuild"
      }
      if [ -d "$INIT_SITE_DIR/out" ]; then
        rsync -a --delete "$INIT_SITE_DIR/out/" "$INIT_OUT_DIR/"
        log "Init site rebuilt and synced to $INIT_OUT_DIR"
        INIT_REBUILT=true
      fi
    else
      log "Node.js not available — skipping init site rebuild"
    fi
  else
    log "Init site source unchanged — skipping rebuild"
  fi
fi

# 6. Apply Talos machineconfig if infrastructure files changed
# When cluster.yaml or talos-cluster module changes, the machineconfig needs to
# be re-applied to running nodes. This is done via tofu apply which detects the
# mc_hash change and re-runs talosctl apply-config --mode=staged automatically.
MC_CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA" -- \
  terraform/modules/talos-cluster/main.tf \
  terraform/modules/talos-cluster/templates/ \
  "envs/${ENV_NAME:-productie}/cluster.yaml" 2>/dev/null | wc -l || echo 0)

MACHINECONFIG_APPLIED=false
if [ "$MC_CHANGED" -gt 0 ]; then
  log "Talos machineconfig files changed ($MC_CHANGED files) — checking for auto-apply..."
  ENV_FILE="${REPO_DIR}/.env"
  STATE_DIR="$HOME/.tofu/state/platform-${ENV_NAME:-productie}"
  TALOSCONFIG_FILE="$REPO_DIR/envs/${ENV_NAME:-productie}/generated/talosconfig"

  if [ ! -f "$STATE_DIR/terraform.tfstate" ]; then
    log "⚠ No Terraform state found at $STATE_DIR — machineconfig auto-apply skipped"
    log "  Manual: cd terraform && tofu apply -target=module.talos_cluster"
  elif [ ! -f "$TALOSCONFIG_FILE" ]; then
    log "⚠ No talosconfig found at $TALOSCONFIG_FILE — machineconfig auto-apply skipped"
    log "  Manual: obtain valid talosconfig, then run: cd terraform && tofu apply -target=module.talos_cluster"
  elif [ ! -f "$ENV_FILE" ]; then
    log "⚠ No .env found — machineconfig auto-apply skipped"
  else
    log "Applying machineconfig changes via tofu apply (this may take 1-2 min)..."
    # Load Proxmox credentials from .env
    PROXMOX_API_TOKEN=$(grep '^PROXMOX_API_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' 2>/dev/null || echo "")
    ENV_NAME_VAL=$(grep '^ENV_NAME=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' 2>/dev/null || echo "productie")
    TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"
    mkdir -p "$TF_PLUGIN_CACHE_DIR"

    cd "$REPO_DIR/terraform"
    VARS=""
    [ -f "../envs/$ENV_NAME_VAL/terraform.tfvars" ]     && VARS="$VARS -var-file=../envs/$ENV_NAME_VAL/terraform.tfvars"
    [ -f "../envs/$ENV_NAME_VAL/services.auto.tfvars" ] && VARS="$VARS -var-file=../envs/$ENV_NAME_VAL/services.auto.tfvars"

    if [ "$JSON_OUTPUT" = "true" ]; then
      TF_VAR_proxmox_api_token="$PROXMOX_API_TOKEN" \
      TF_PLUGIN_CACHE_DIR="$TF_PLUGIN_CACHE_DIR" \
      tofu init -backend-config="path=$STATE_DIR/terraform.tfstate" -reconfigure -input=false >/dev/null 2>&1 || true
    else
      TF_VAR_proxmox_api_token="$PROXMOX_API_TOKEN" \
      TF_PLUGIN_CACHE_DIR="$TF_PLUGIN_CACHE_DIR" \
      tofu init -backend-config="path=$STATE_DIR/terraform.tfstate" -reconfigure -input=false 2>&1 | tail -3 || true
    fi

    # Apply only the talos_cluster module — this regenerates machineconfigs and
    # re-applies them to running nodes via talosctl apply-config --mode=staged
    # when mc_hash trigger detects a content change.
    if [ "$JSON_OUTPUT" = "true" ]; then
      if TF_VAR_proxmox_api_token="$PROXMOX_API_TOKEN" \
         TF_PLUGIN_CACHE_DIR="$TF_PLUGIN_CACHE_DIR" \
         tofu apply $VARS -target=module.talos_cluster -auto-approve -input=false >/dev/null 2>&1; then
        log "✅ Machineconfig applied successfully"
        MACHINECONFIG_APPLIED=true
      else
        log "⚠ Machineconfig apply failed — check terraform output above"
        log "  Manual: cd terraform && tofu apply -target=module.talos_cluster"
      fi
    else
      if TF_VAR_proxmox_api_token="$PROXMOX_API_TOKEN" \
         TF_PLUGIN_CACHE_DIR="$TF_PLUGIN_CACHE_DIR" \
         tofu apply $VARS -target=module.talos_cluster -auto-approve -input=false 2>&1; then
        log "✅ Machineconfig applied successfully"
        MACHINECONFIG_APPLIED=true
      else
        log "⚠ Machineconfig apply failed — check terraform output above"
        log "  Manual: cd terraform && tofu apply -target=module.talos_cluster"
      fi
    fi
    cd "$REPO_DIR"
  fi
fi

CHANGELOG_JSON=$(echo "$CHANGELOG" | python3 -c 'import sys,json; lines=[l for l in sys.stdin.read().splitlines() if l.strip()]; print(json.dumps(lines))')

jout "{\"ok\":true,\"updated\":true,\"oldSha\":\"$OLD_SHA\",\"newSha\":\"$NEW_SHA\",\"changelog\":${CHANGELOG_JSON},\"initRebuilt\":$INIT_REBUILT,\"machineConfigApplied\":$MACHINECONFIG_APPLIED}"

log "Update complete: $OLD_SHA → $NEW_SHA"
