---
title: ArgoCD false-positive Degraded alerts — causes and fixes
description: Three patterns that cause ArgoCD apps to show Degraded transiently without real issues
---

# ArgoCD False-Positive Degraded Alerts

## Memory

- **File paths:**
  - `kubernetes/bootstrap/appproject-platform.yaml` — AppProject orphanedResources config
  - `kubernetes/core/argocd/manifests/self-healer.yaml` — grace period logic

## Root Causes Found

### 1. OrphanedResourceWarning → Degraded on manifests apps
- **Trigger:** `orphanedResources.warn: true` in AppProject + resources in namespace not tracked by manifests app
- **Example:** `core-argocd-manifests` targets `argocd` namespace. ArgoCD's own Helm-managed secrets/configmaps exist there but aren't in the manifests app's git path → 28 "orphaned" resources → app goes Degraded
- **Fix:** Set `orphanedResources.warn: false` in AppProject for platform management namespaces (`argocd`, `kube-system`)
- **Why it matters:** With warn=true every new Helm-managed resource in the namespace causes a Degraded flash

### 2. App-of-apps cascade Degraded (bootstrap)
- **Trigger:** Parent app (`bootstrap`) tracks child Application resources. When any child app runs a PostSync hook (Job), the child briefly shows as Degraded → parent cascades to Degraded
- **Example:** `catalog-onedev-manifests` runs a bootstrap Job via PostSync hook → brief Degraded → `bootstrap` goes Degraded for 2 minutes
- **Fix:** Self-healer grace period — only alert if app has been Degraded for > 15 minutes (1 full healer cycle)
- **Detection:** Check `status.health.lastTransitionTime` and compute `(now - lastTransition) > 900s`

### 3. Transient ExternalSecret provisioning
- **Trigger:** When a new ExternalSecret is created, ESO briefly shows it as `Processing/NotReady` → parent app (core-external-secrets-manifests) goes Degraded for 1-2 minutes
- **Fix:** Same grace period as above (15 minutes)

## Self-Healer Grace Period Implementation

```bash
# In the self-healer script:
NOW_EPOCH=$(date -u +%s)
DEGRADED_GRACE_SECONDS=900  # 15 minutes

APPS=$(kubectl get applications -n "$NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.health.status}{"\t"}{.status.sync.status}{"\t"}{.status.operationState.phase}{"\t"}{.status.health.lastTransitionTime}{"\n"}{end}')

while IFS=$'\t' read -r APP HEALTH SYNC OP_PHASE TRANSITION_TIME; do
  if [ "$HEALTH" = "Degraded" ]; then
    TRANSITION_EPOCH=$(date -u -d "$TRANSITION_TIME" +%s 2>/dev/null || echo 0)
    DEGRADED_SECONDS=$(( NOW_EPOCH - TRANSITION_EPOCH ))
    if [ "$DEGRADED_SECONDS" -lt "$DEGRADED_GRACE_SECONDS" ]; then
      continue  # transient, skip
    fi
    # persistent degraded — alert
  fi
done
```

## Validation
- Run self-healer test job: `kubectl create job -n argocd --from=cronjob/argocd-self-healer test-job`
- Check logs: should see "within Xs grace" for recently-changed apps, not Discord noise
- Check AppProject: `kubectl get appproject platform -n argocd -o jsonpath='{.spec.orphanedResources}'`
