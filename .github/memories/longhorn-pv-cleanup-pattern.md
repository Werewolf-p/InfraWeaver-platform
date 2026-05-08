# Longhorn PV Cleanup Pattern

## Problem
When apps are redeployed (deleted + recreated), PVCs are deleted but the underlying PVs and
Longhorn volumes persist because StorageClass `longhorn-retain` has `reclaimPolicy: Retain`.

Over time, "Released" PVs accumulate. Even though they hold no active data, Longhorn still
counts them toward `storageScheduled` per node. This causes:
- `storageScheduled > storageMaximum` → disk over-scheduling
- New volumes: "No available disk candidates to create a new replica"
- New PVCs get faulted Longhorn volumes immediately

## Detection
```bash
# Check if disks are over-scheduled
kubectl get nodes.longhorn.io -n longhorn-system -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for node in data['items']:
  name = node['metadata']['name']
  for disk_id, disk in node['status']['diskStatus'].items():
    total = disk['storageMaximum']
    sched = disk['storageScheduled']
    print(f'{name}: total={total//1073741824}Gi sched={sched//1073741824}Gi over={sched>total}')
"
# List Released PVs
kubectl get pv | grep Released
```

## Fix
```bash
# Delete all Released PVs (no active PVC is using them)
kubectl get pv | grep Released | awk '{print $1}' | xargs kubectl delete pv
# Delete their Longhorn volumes too
kubectl get pv | grep Released | awk '{print $1}' | while read pv; do
  kubectl delete volume.longhorn.io "$pv" -n longhorn-system 2>/dev/null
done
```

## Long-term Fix
Consider changing StorageClass to `reclaimPolicy: Delete` for non-critical data, or
add a periodic CronJob that cleans up Released PVs/Longhorn volumes automatically.

## Faulted Volume Recovery
If a new PVC gets a faulted volume (all replicas fail immediately):
1. Delete the faulted Longhorn volume: `kubectl delete volume.longhorn.io <pvc-name> -n longhorn-system`
2. Delete the stuck PVC (patch to remove finalizer if Terminating): `kubectl patch pvc <name> -n <ns> -p '{"metadata":{"finalizers":[]}}' --type=merge`
3. Delete and recreate the StatefulSet/Deployment — ArgoCD will recreate the PVC → new healthy volume

## Catalog AppSet Anti-Pattern
**DO NOT use ApplicationSet with git directory generator for optional/enabled catalog apps.**
The git directory generator scans ALL matching directories — it cannot filter by platform.yaml
`enabled` list. Use `sync-catalog.sh` to generate individual Application files per enabled app.

Pattern to avoid:
```yaml
generators:
  - git:
      directories:
        - path: 'kubernetes/catalog/*/manifests'  # scans ALL 27+ dirs, not just enabled ones
```
