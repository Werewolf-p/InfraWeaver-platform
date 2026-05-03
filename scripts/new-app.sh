#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# new-app.sh — Scaffold a new Kubernetes app for ArgoCD auto-discovery
#
# USAGE:
#   bash scripts/new-app.sh <app-name> <tier> [chart-repo] [chart-name]
#
# EXAMPLES:
#   bash scripts/new-app.sh my-service apps
#   bash scripts/new-app.sh my-monitoring monitoring https://prometheus-community.github.io/helm-charts kube-prometheus-stack
#   bash scripts/new-app.sh redis-cache core https://charts.bitnami.com/bitnami redis
#
# TIERS: apps | core | monitoring
#
# What this creates:
#   kubernetes/<tier>/<app-name>/
#     application.yaml   — ArgoCD app descriptor (edit repoURL/chart/namespace)
#     values.yaml        — Helm values skeleton
#     manifests/.gitkeep — Placeholder for raw K8s manifests
#
# After running:
#   1. Edit application.yaml to set your actual chart repo and version
#   2. Edit values.yaml to configure the chart
#   3. git add + commit + push
#   4. ArgoCD auto-discovers and deploys within ~3 minutes
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
fail() { echo -e "${RED}❌ $*${NC}"; exit 1; }
info() { echo -e "${BLUE}ℹ️  $*${NC}"; }

APP_NAME=${1:-}
TIER=${2:-apps}
CHART_REPO=${3:-https://charts.example.com}
CHART_NAME=${4:-$APP_NAME}

if [ -z "$APP_NAME" ]; then
  echo "USAGE: bash scripts/new-app.sh <app-name> [tier] [chart-repo] [chart-name]"
  echo "  tier: apps | core | monitoring (default: apps)"
  exit 1
fi

# Validate tier
case "$TIER" in
  apps|core|monitoring) ;;
  *) fail "Invalid tier '${TIER}'. Must be: apps | core | monitoring" ;;
esac

TARGET_DIR="kubernetes/${TIER}/${APP_NAME}"

if [ -d "$TARGET_DIR" ]; then
  fail "Directory ${TARGET_DIR} already exists — app '${APP_NAME}' already scaffolded"
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   InfraWeaver — Scaffolding New App                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
info "App name : ${APP_NAME}"
info "Tier     : ${TIER}"
info "Target   : ${TARGET_DIR}/"
echo ""

# Create directory structure
mkdir -p "${TARGET_DIR}/manifests"

# ── application.yaml ─────────────────────────────────────────────────────────
cat > "${TARGET_DIR}/application.yaml" << APPEOF
# ── ${APP_NAME} ──────────────────────────────────────────────────────────────
# ArgoCD ApplicationSet auto-discovers this file.
# Edit repoURL, chart, targetRevision and namespace for your app.
#
# After pushing, ArgoCD creates an Application named: ${TIER}-${APP_NAME}
# Check status in ArgoCD UI: https://argocd.int.rlservers.com
# ─────────────────────────────────────────────────────────────────────────────
repoURL: ${CHART_REPO}
targetRevision: "*"      # TODO: pin to a specific version e.g. "1.2.3"
chart: ${CHART_NAME}
releaseName: ${APP_NAME}
namespace: ${TIER}-${APP_NAME}
APPEOF

ok "Created ${TARGET_DIR}/application.yaml"

# ── values.yaml ──────────────────────────────────────────────────────────────
cat > "${TARGET_DIR}/values.yaml" << VALEOF
# ── ${APP_NAME} Helm Values ───────────────────────────────────────────────────
# Configure your chart here. Refer to the chart's own values.yaml for all options.
# These values override the chart defaults.
# ─────────────────────────────────────────────────────────────────────────────

# Example: resource limits (always set these to prevent resource exhaustion)
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

# Example: replicas
replicaCount: 1

# TODO: add chart-specific values here
VALEOF

ok "Created ${TARGET_DIR}/values.yaml"

# ── manifests/.gitkeep ───────────────────────────────────────────────────────
touch "${TARGET_DIR}/manifests/.gitkeep"
ok "Created ${TARGET_DIR}/manifests/ (for raw K8s manifests)"

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${GREEN}✅ App '${APP_NAME}' scaffolded at ${TARGET_DIR}/${NC}"
echo ""
echo "  Next steps:"
echo "    1. Edit ${TARGET_DIR}/application.yaml"
echo "       - Set repoURL to your Helm chart repo"
echo "       - Set targetRevision to a specific version (not '*')"
echo "       - Set namespace appropriately"
echo ""
echo "    2. Edit ${TARGET_DIR}/values.yaml"
echo "       - Configure chart-specific settings"
echo "       - Always set resource requests/limits"
echo ""
echo "    3. Push to git:"
echo "       git add ${TARGET_DIR}/"
echo "       git commit -m 'feat: add ${APP_NAME} app'"
echo "       git push"
echo ""
echo "    4. ArgoCD auto-discovers it within ~3 minutes"
echo "       App name in ArgoCD: ${TIER}-${APP_NAME}"
echo ""
warn "Don't forget to pin targetRevision to a specific version before production use!"
