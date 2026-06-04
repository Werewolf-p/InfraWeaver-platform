#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/netbird-full-deploy.sh — Full clean reinstall of NetBird
#
# Run from the homelab control node (needs kubectl + argocd CLI access).
#
# What it does:
#   1. Deletes the netbird-management-data PVC (wipes SQLite DB for fresh EmbeddedIdP)
#   2. Deletes remaining netbird namespace resources (deployments, jobs, pods)
#   3. Syncs app-external-routes (Traefik IngressRoutes, ServersTransports)
#   4. Syncs apps-netbird (management, relay, signal, dashboard, bootstrap job)
#   5. Waits for all pods to be ready
#   6. Deletes and re-triggers the bootstrap job (SQLite seed + API phase)
#   7. Waits for bootstrap job to complete
#   8. Prints connection instructions
#
# Usage:
#   bash scripts/deploy/netbird-full-deploy.sh
# =============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}==>${NC} $*"; }
ok()      { echo -e "${GREEN}  OK${NC} $*"; }
warn()    { echo -e "${YELLOW}  WARN${NC} $*"; }
die()     { echo -e "${RED}  ERROR${NC} $*" >&2; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
for bin in kubectl argocd; do
  command -v "$bin" &>/dev/null || die "Required tool not found: $bin"
done

NAMESPACE="netbird"
ARGOCD_NETBIRD_APP="apps-netbird"
ARGOCD_ROUTES_APP="app-external-routes"
MANAGEMENT_SS="netbird-management"
PVC_NAME="netbird-management-data"
BOOTSTRAP_JOB="netbird-db-bootstrap"
BOOTSTRAP_CONFIGMAP="netbird-bootstrap-script"

echo ""
echo "=================================================================="
echo "  NetBird Full Clean Reinstall"
echo "  Domain : https://netbird.rlservers.com"
echo "  IdP    : EmbeddedIdP (management IS the identity provider)"
echo "=================================================================="
echo ""

# =============================================================================
# STEP 1 — Scale management to 0 and delete PVC (wipe SQLite DB)
# =============================================================================
info "STEP 1: Wiping old NetBird state"

# Scale management StatefulSet to 0 first to release the RWO PVC
if kubectl get statefulset "$MANAGEMENT_SS" -n "$NAMESPACE" &>/dev/null; then
  info "  Scaling $MANAGEMENT_SS to 0 to release PVC..."
  kubectl scale statefulset "$MANAGEMENT_SS" -n "$NAMESPACE" --replicas=0
  kubectl wait --for=delete pod -l app=netbird-management -n "$NAMESPACE" --timeout=90s 2>/dev/null || true
  ok "Management pods terminated"
else
  warn "StatefulSet $MANAGEMENT_SS not found — skipping scale-down"
fi

# Delete the bootstrap job so it can be re-triggered cleanly
if kubectl get job "$BOOTSTRAP_JOB" -n "$NAMESPACE" &>/dev/null; then
  info "  Deleting existing bootstrap job..."
  kubectl delete job "$BOOTSTRAP_JOB" -n "$NAMESPACE" --ignore-not-found
  ok "Bootstrap job deleted"
fi

# Delete the PVC — this wipes the SQLite DB for a fresh EmbeddedIdP start
if kubectl get pvc "$PVC_NAME" -n "$NAMESPACE" &>/dev/null; then
  info "  Deleting PVC $PVC_NAME (wipes SQLite DB — fresh start)..."
  kubectl delete pvc "$PVC_NAME" -n "$NAMESPACE"
  # Wait for PVC to be gone (may take a moment with local-path)
  for i in $(seq 1 30); do
    kubectl get pvc "$PVC_NAME" -n "$NAMESPACE" &>/dev/null || break
    echo "    Waiting for PVC deletion... ($i/30)"
    sleep 2
  done
  ok "PVC deleted"
else
  warn "PVC $PVC_NAME not found — nothing to wipe"
fi

# Delete any remaining deployments/pods to ensure clean slate
info "  Cleaning up remaining namespace resources..."
kubectl delete deployment --all -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl delete pods --all -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
sleep 3
ok "Namespace resources cleaned"

# =============================================================================
# STEP 2 — Resume + sync app-external-routes (Traefik routes + ServersTransports)
# =============================================================================
info "STEP 2: Syncing $ARGOCD_ROUTES_APP"

if argocd app get "$ARGOCD_ROUTES_APP" &>/dev/null; then
  argocd app resume "$ARGOCD_ROUTES_APP" 2>/dev/null || true
  argocd app sync "$ARGOCD_ROUTES_APP" --prune --retry-limit 3
  argocd app wait "$ARGOCD_ROUTES_APP" --health --timeout 120
  ok "$ARGOCD_ROUTES_APP synced and healthy"
else
  warn "ArgoCD app $ARGOCD_ROUTES_APP not found — skipping (routes may already be applied)"
fi

# =============================================================================
# STEP 3 — Resume + sync apps-netbird
# =============================================================================
info "STEP 3: Syncing $ARGOCD_NETBIRD_APP"

if argocd app get "$ARGOCD_NETBIRD_APP" &>/dev/null; then
  argocd app resume "$ARGOCD_NETBIRD_APP" 2>/dev/null || true
  # Sync with Replace=true support (bootstrap Job has immutable spec)
  argocd app sync "$ARGOCD_NETBIRD_APP" --prune --retry-limit 3 \
    --sync-option Replace=true
  ok "$ARGOCD_NETBIRD_APP sync triggered"
else
  die "ArgoCD app $ARGOCD_NETBIRD_APP not found. Is ArgoCD logged in?"
fi

# =============================================================================
# STEP 4 — Wait for core pods to be ready
# =============================================================================
info "STEP 4: Waiting for NetBird pods to be ready"

for deploy in netbird-relay netbird-signal netbird-dashboard; do
  info "  Waiting for $deploy..."
  kubectl rollout status deployment "$deploy" -n "$NAMESPACE" --timeout=180s
  ok "$deploy ready"
done

info "  Waiting for $MANAGEMENT_SS StatefulSet..."
kubectl rollout status statefulset "$MANAGEMENT_SS" -n "$NAMESPACE" --timeout=180s
ok "$MANAGEMENT_SS ready"

# Extra wait for management API to respond before bootstrap
info "  Waiting for management HTTP API to respond..."
for i in $(seq 1 36); do
  CODE=$(kubectl exec -n "$NAMESPACE" \
    "$(kubectl get pod -n "$NAMESPACE" -l app=netbird-management -o jsonpath='{.items[0].metadata.name}')" \
    -- wget -qO- --timeout=3 http://localhost:80/api/status 2>/dev/null | head -1 || echo "")
  # Any response (even 401/404) means the API is up
  HTTP=$(kubectl run netbird-probe-$i --rm -i --restart=Never --image=curlimages/curl:8.7.1 \
    -n "$NAMESPACE" -- curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
    http://netbird-management.netbird.svc:80/api/status 2>/dev/null || echo "000")
  if [ "$HTTP" != "000" ]; then
    ok "Management API responding (HTTP $HTTP)"
    break
  fi
  echo "    Attempt $i/36: API not ready yet, waiting 5s..."
  sleep 5
done

# =============================================================================
# STEP 5 — Delete and re-trigger the bootstrap job
# =============================================================================
info "STEP 5: Triggering bootstrap job"

# Delete completed/failed job if it exists (ArgoCD may have created it already)
if kubectl get job "$BOOTSTRAP_JOB" -n "$NAMESPACE" &>/dev/null; then
  info "  Deleting existing bootstrap job (ArgoCD will recreate on next sync)..."
  kubectl delete job "$BOOTSTRAP_JOB" -n "$NAMESPACE" --ignore-not-found
  sleep 2
fi

# Re-sync to let ArgoCD recreate the job from git
info "  Re-syncing $ARGOCD_NETBIRD_APP to recreate bootstrap job..."
argocd app sync "$ARGOCD_NETBIRD_APP" --prune --retry-limit 3 \
  --sync-option Replace=true
ok "Bootstrap job recreated"

# =============================================================================
# STEP 6 — Wait for bootstrap job to complete
# =============================================================================
info "STEP 6: Waiting for bootstrap job to complete (max 10 minutes)"

# Wait for the job pod to appear
for i in $(seq 1 24); do
  JOB_POD=$(kubectl get pod -n "$NAMESPACE" \
    -l "job-name=$BOOTSTRAP_JOB" \
    --field-selector=status.phase!=Pending \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  [ -n "$JOB_POD" ] && break
  echo "    Waiting for bootstrap pod to start... ($i/24)"
  sleep 5
done

if [ -z "${JOB_POD:-}" ]; then
  # Try without phase filter
  JOB_POD=$(kubectl get pod -n "$NAMESPACE" \
    -l "job-name=$BOOTSTRAP_JOB" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
fi

if [ -n "${JOB_POD:-}" ]; then
  info "  Bootstrap pod: $JOB_POD — streaming logs..."
  kubectl logs -n "$NAMESPACE" "$JOB_POD" -c fix-db --follow 2>/dev/null || \
    kubectl logs -n "$NAMESPACE" "$JOB_POD" --follow 2>/dev/null || true
fi

# Wait for job completion
info "  Waiting for job $BOOTSTRAP_JOB to complete..."
kubectl wait job "$BOOTSTRAP_JOB" -n "$NAMESPACE" \
  --for=condition=complete --timeout=600s || {
  warn "Bootstrap job did not complete successfully within 10 minutes"
  info "  Checking job status..."
  kubectl describe job "$BOOTSTRAP_JOB" -n "$NAMESPACE" || true
  kubectl get pods -n "$NAMESPACE" -l "job-name=$BOOTSTRAP_JOB" || true
  die "Bootstrap failed — check logs above"
}
ok "Bootstrap job completed successfully"

# =============================================================================
# STEP 7 — Final health check
# =============================================================================
info "STEP 7: Final health check"

echo ""
kubectl get pods -n "$NAMESPACE"
echo ""

argocd app get "$ARGOCD_NETBIRD_APP" --show-operation 2>/dev/null | \
  grep -E "Health Status|Sync Status" || true

# =============================================================================
# DONE — Print connection instructions
# =============================================================================
echo ""
echo "=================================================================="
echo -e "${GREEN}  NetBird deployment complete!${NC}"
echo "=================================================================="
echo ""
echo "  Dashboard URL : https://netbird.rlservers.com"
echo ""
echo "  First-time setup:"
echo "    1. Open https://netbird.rlservers.com in your browser"
echo "    2. Click 'Sign Up' — the FIRST registered user becomes admin"
echo "    3. Use any email + password (stored in EmbeddedIdP, no external OIDC)"
echo ""
echo "  Connect a NetBird client:"
echo "    netbird up --management-url https://netbird.rlservers.com"
echo ""
echo "  Or use a setup key (infrastructure-key from OpenBao secret):"
echo "    netbird up --management-url https://netbird.rlservers.com \\"
echo "               --setup-key <SETUP_KEY from secret/platform/netbird>"
echo ""
echo "  Reconnect the VLAN3 router VM after fresh install:"
echo "    bash scripts/deploy/reconnect-netbird.sh"
echo ""
echo "=================================================================="
