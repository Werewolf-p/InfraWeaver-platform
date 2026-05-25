# ArgoCD Namespace Deletion / App Pruning — CRITICAL SAFETY RULES

## The disaster pattern (happened 2026-05-25)
When ArgoCD's `prune: true` is enabled for an app AND the git manifest is deleted or the app becomes
orphaned, ArgoCD **deletes the entire namespace and all resources inside it** — including databases,
PVCs, and StatefulSets. This happened to the `onedev` namespace, wiping the PostgreSQL database.

## Current safeguards in place
1. **`onedev` app**: `syncOptions: [PrunePropagationPolicy=orphan]` — resources are orphaned not deleted
2. **Longhorn volumes**: Retain policy on PVCs (LonghornStorageClass has `reclaimPolicy: Retain`)
3. **OneDev backup**: Daily PostgreSQL dump to Longhorn volume (CronJob in onedev namespace)

## Rules for new deployments
1. **Always set `CreateNamespace=true` in syncOptions** — lets ArgoCD own the namespace
2. **For StatefulSet apps with databases**: add `PrunePropagationPolicy=orphan` to prevent accidental DB deletion
3. **Never delete a bootstrap Application YAML while the app is still running** — ArgoCD will prune everything
4. **To decommission an app safely**:
   ```bash
   # Step 1: Set app to suspended/disabled first
   kubectl patch application -n argocd <app-name> --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}'
   # Step 2: Manually delete namespace
   kubectl delete namespace <ns>
   # Step 3: Remove the Application resource from git
   ```

## Longhorn volume recovery
If a PVC is deleted but the Longhorn volume was `Retain` policy:
```bash
# Volume still exists in longhorn-system
kubectl get volume -n longhorn-system | grep detached
# Re-attach by creating a new PV/PVC pointing to the volume name
```

## OneDev backup location
- Backup PVC: `onedev-backup-data` in `onedev` namespace
- Backup CronJob: `onedev-postgres-backup` — runs daily at 2am
- Restore: `kubectl exec -n onedev <postgres-pod> -- psql -U onedev onedev < /backup/latest.sql`
