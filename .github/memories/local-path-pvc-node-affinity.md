---
title: Local-path PVC Node Affinity Gotcha
description: Pods mounting local-path PVCs MUST schedule on the bound node; edits to wrong-node directories have no effect
---

# Local-path PVC Node Affinity

## Memory

- **File paths:** Any pod that mounts a `local-path` PVC
- **Decision:** Always verify `kubectl get pod -o wide` to confirm pod scheduled on the same node as PVC
- **Why it matters:** Kubernetes enforces PV nodeAffinity for local-path PVCs. A pod mounting the PVC will be scheduled on the bound node. If you `kubectl exec` into a pod on a DIFFERENT node, you're reading/writing a completely different (empty) local directory — your changes have no effect.

## How to Check

```bash
# Find which node the PVC is bound to
kubectl get pvc netbird-management-data -n netbird -o jsonpath='{.spec.volumeName}' \
  | xargs kubectl get pv -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}'

# Verify the pod is on the correct node
kubectl get pod netbird-management -n netbird -o wide
# NODE column must match the PVC-bound node
```

## In This Repo

- PVC `netbird-management-data` → PV `pvc-699f52ee-4b1f-4ac2-8ef7-63499d753783` → bound to **`talos-prod-cp2`** (10.25.0.91)
- Any bootstrap pod mounting this PVC will automatically schedule on `talos-prod-cp2`
- ArgoCD may evict non-GitOps pods; use `--rm` or check pod lifespan when using for DB edits

## Lesson Learned

During NetBird bootstrap, multiple sessions created bootstrap pods (`db-fix`, `bootstrap2`) that ran on wrong nodes and edited empty local directories. The actual DB on `talos-prod-cp2` was untouched. Only after discovering the `pvc-699f52ee...` nodeAffinity and creating `netbird-bootstrap3` explicitly on cp2 did the DB edits take effect.

## Related

- `platform/kubernetes/apps/netbird/manifests/management.yaml` — uses `netbird-management-data` PVC with `Recreate` strategy (required for RWO)
- `memories/netbird-v0.69.0-db-bootstrap.md`
