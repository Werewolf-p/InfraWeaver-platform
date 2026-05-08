# ArgoCD Self-Healer CronJob

## Location
`kubernetes/core/argocd/manifests/self-healer.yaml`

## What it does
Runs every 15 minutes. Finds apps that are `OutOfSync` or `Unknown` sync status and:
1. **Pass 1**: Hard-refreshes all such apps (patches `argocd.argoproj.io/refresh: hard` annotation)
2. **Waits 20s** for ArgoCD to recompute diffs
3. **Pass 2**: Syncs apps still `OutOfSync` after refresh (patches `.operation.sync`)

Skips:
- Apps with a running operation (`operationState.phase = Running`)
- Degraded apps (need human review)

## RBAC
`ServiceAccount: argocd-self-healer` in `argocd` namespace.
`ClusterRole`: only `get/list/patch` on `argoproj.io/applications`. No cluster-admin, no secrets.

## Image
**Must use `bitnami/kubectl:latest`** — NOT `quay.io/argoproj/argocd:v3.4.1`.
The ArgoCD image does NOT have `kubectl` in its PATH (only has `argocd`, `helm`, `kustomize` etc.).
`bitnami/kubectl:latest` has bash + kubectl and works with in-cluster ServiceAccount tokens.

## Critical bash gotcha: process substitution vs pipe
**WRONG** — pipe creates subshell, counter increments are lost in outer scope:
```bash
echo "$APPS" | while IFS=$'\t' read -r APP ...; do
  REFRESHED=$((REFRESHED+1))  # this DOES NOT propagate to outer shell
done
if [ "$REFRESHED" -gt 0 ]; then sleep 20; fi  # NEVER RUNS
```

**CORRECT** — process substitution keeps the while loop in the current shell:
```bash
while IFS=$'\t' read -r APP ...; do
  REFRESHED=$((REFRESHED+1))  # propagates correctly
done < <(echo "$APPS")
if [ "$REFRESHED" -gt 0 ]; then sleep 20; fi  # works
```

## Why Unknown sync status happens
ArgoCD's background refresh cache can become stale. Apps show `Healthy+Unknown` when
ArgoCD hasn't recomputed the sync diff recently. Hard-refresh resolves this without syncing.

## Testing
```bash
kubectl create job -n argocd --from=cronjob/argocd-self-healer self-healer-test
kubectl logs -n argocd job/self-healer-test
```
Expected output when all Synced:
```
[self-healer] Thu May 7 19:33:33 UTC 2026 — scanning ArgoCD apps in namespace: argocd
[self-healer] Done. refreshed=0 synced=0 skipped=0
```
Expected output with Unknown apps:
```
  REFRESH  apps-example-app [health=Healthy sync=Unknown]
[self-healer] Waiting 20s for 1 refresh(es) to propagate...
[self-healer] Done. refreshed=1 synced=0 skipped=0
```

## Enhanced: Synced+Degraded Hard-Refresh (2026-05)

### Problem
`catalog-gatus-manifests` was Synced+Degraded because its ExternalSecret used wrong
ClusterSecretStore name (`openbao-backend` instead of `openbao`). The old self-healer
skipped all Degraded apps regardless of sync status.

### Root cause of Gatus failure
- ExternalSecret `secretStoreRef.name: openbao-backend` → should be `openbao`
- ESO fails to create `gatus-discord-secret` → Pod can't get env var → CrashLoopBackOff
- **All other ExternalSecrets in the platform use `name: openbao`** (not `openbao-backend`)

### Self-healer enhancement
For Synced+Degraded apps that have been degraded > grace period:
1. **Hard-refresh** (patch `argocd.argoproj.io/refresh: hard` annotation)
2. Wait 20s for ArgoCD to recompute diff
3. **Pass 2 check**: if now OutOfSync → auto-sync (stale cache resolved itself!)
4. If still Synced+Degraded → add to DEGRADED_APPS for Discord notification (human needed)

### Why hard-refresh helps Synced+Degraded
ArgoCD's sync cache can be stale: a git push that fixes a manifest may not be reflected
immediately. The cache shows "Synced" but git actually has changes. Hard-refresh forces
ArgoCD to recompute from git, which often reveals OutOfSync → self-healer can then sync.

### When hard-refresh doesn't help (still needs human)
- Wrong image version (pull fails)
- CrashLoopBackOff from bad config (needs code fix)
- ResourceQuota exceeded (needs infra change)
- Missing persistent volume (needs storage fix)
