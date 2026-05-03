#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# new-app.sh — Scaffold a new Kubernetes app for ArgoCD auto-discovery
#
# USAGE:
#   bash scripts/new-app.sh <app-name> [options]
#
# OPTIONS:
#   --tier <tier>          Tier to place the app in (default: apps)
#                          Valid: apps | core | monitoring | platform
#   --helm <repo> <chart>  Helm chart mode: create application.yaml + values.yaml
#   --manifest-only        Manifest-only mode: skip application.yaml (raw YAML only)
#
# EXAMPLES:
#   bash scripts/new-app.sh my-service
#   bash scripts/new-app.sh my-service --helm https://charts.bitnami.com/bitnami redis
#   bash scripts/new-app.sh my-service --tier platform
#   bash scripts/new-app.sh my-service --manifest-only
#
# What this creates (manifest-only mode, the default):
#   kubernetes/<tier>/<app-name>/
#     manifests/
#       namespace.yaml         — Namespace with Pod Security Admission labels
#       serviceaccount.yaml    — Dedicated ServiceAccount (no default SA)
#       networkpolicy.yaml     — Default-deny + allow from Traefik only
#       deployment.yaml        — Secure Deployment template (non-root, read-only fs)
#       service.yaml           — ClusterIP Service
#       resourcequota.yaml     — Namespace CPU/memory limits
#       ingressroute-internal.yaml.example  — VPN-only route (rename to .yaml to activate)
#       ingressroute-public.yaml.example    — Public route (rename + review before using)
#
# Adding a Helm chart (--helm flag adds):
#   kubernetes/<tier>/<app-name>/
#     application.yaml   — ArgoCD ApplicationSet descriptor
#     values.yaml        — Helm chart values skeleton
#
# See: docs/templates/app/README.md for full documentation
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
fail() { echo -e "${RED}❌ $*${NC}"; exit 1; }
info() { echo -e "${BLUE}ℹ️  $*${NC}"; }

# ── Argument parsing ─────────────────────────────────────────────────────────
APP_NAME=${1:-}
TIER="apps"
MODE="manifest"   # manifest | helm | manifest-only
CHART_REPO=""
CHART_NAME=""

if [ -z "$APP_NAME" ]; then
  echo -e "${BOLD}USAGE:${NC} bash scripts/new-app.sh <app-name> [--tier <tier>] [--helm <repo> <chart>] [--manifest-only]"
  exit 1
fi

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)
      TIER="${2:-apps}"; shift 2 ;;
    --helm)
      MODE="helm"
      CHART_REPO="${2:-https://charts.example.com}"
      CHART_NAME="${3:-$APP_NAME}"
      shift 3 ;;
    --manifest-only)
      MODE="manifest-only"; shift ;;
    *)
      fail "Unknown option: $1" ;;
  esac
done

# Validate tier
case "$TIER" in
  apps|core|monitoring|platform) ;;
  *) fail "Invalid tier '${TIER}'. Must be: apps | core | monitoring | platform" ;;
esac

TEMPLATE_DIR="docs/templates/app"
TARGET_DIR="kubernetes/${TIER}/${APP_NAME}"

if [ ! -d "$TEMPLATE_DIR" ]; then
  fail "Template directory not found: ${TEMPLATE_DIR} — run this script from the repo root"
fi

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
info "Mode     : ${MODE}"
info "Target   : ${TARGET_DIR}/"
echo ""

# ── Copy manifests from template ─────────────────────────────────────────────
mkdir -p "${TARGET_DIR}/manifests"

for tmpl_file in "${TEMPLATE_DIR}/manifests/"*; do
  filename=$(basename "$tmpl_file")
  dest="${TARGET_DIR}/manifests/${filename}"
  sed "s/APP_NAME/${APP_NAME}/g" "$tmpl_file" > "$dest"
  ok "Created ${dest}"
done

# ── Helm chart files ──────────────────────────────────────────────────────────
if [[ "$MODE" == "helm" ]]; then
  # application.yaml from template, substituting APP_NAME, chart, repo
  sed \
    -e "s|APP_NAME|${APP_NAME}|g" \
    -e "s|https://charts.example.com|${CHART_REPO}|g" \
    -e "s|chart: APP_NAME|chart: ${CHART_NAME}|g" \
    "${TEMPLATE_DIR}/application.yaml.tmpl" > "${TARGET_DIR}/application.yaml"
  ok "Created ${TARGET_DIR}/application.yaml"

  sed "s/APP_NAME/${APP_NAME}/g" "${TEMPLATE_DIR}/values.yaml.tmpl" > "${TARGET_DIR}/values.yaml"
  ok "Created ${TARGET_DIR}/values.yaml"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${GREEN}✅ App '${APP_NAME}' scaffolded at ${TARGET_DIR}/${NC}"
echo ""
echo -e "  ${BOLD}Security defaults already baked in:${NC}"
echo "    ✅ NetworkPolicy: default-deny + allow only from Traefik"
echo "    ✅ Dedicated ServiceAccount (no auto-mount)"
echo "    ✅ Pod Security Admission: restricted"
echo "    ✅ Secure pod template (non-root, read-only fs, drop ALL caps)"
echo "    ✅ ResourceQuota on namespace"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo "    1. Update the image in ${TARGET_DIR}/manifests/deployment.yaml"
echo "       - Set 'image' to your actual container image"
echo "       - Set 'containerPort' to match your app's listening port"
echo ""
echo "    2. Choose your access mode:"
echo "       Internal (VPN only):"
echo "         mv ${TARGET_DIR}/manifests/ingressroute-internal.yaml.example \\"
echo "            ${TARGET_DIR}/manifests/ingressroute-internal.yaml"
echo "       Public internet:"
echo "         mv ${TARGET_DIR}/manifests/ingressroute-public.yaml.example \\"
echo "            ${TARGET_DIR}/manifests/ingressroute-public.yaml"
echo ""
if [[ "$MODE" == "helm" ]]; then
  echo "    3. Pin the chart version in ${TARGET_DIR}/application.yaml"
  echo "       (targetRevision: \"1.0.0\" — never use \"*\" in production)"
  echo ""
fi
echo "    3. Push to git:"
echo "       git add ${TARGET_DIR}/"
echo "       git commit -m 'feat: add ${APP_NAME} app'"
echo "       git push"
echo ""
echo "    4. ArgoCD auto-deploys within ~60 seconds"
echo "       https://argocd.int.rlservers.com"
echo ""
warn "Replace all APP_NAME placeholders before pushing!"
warn "Review resource limits in deployment.yaml and resourcequota.yaml for your app's actual needs"
