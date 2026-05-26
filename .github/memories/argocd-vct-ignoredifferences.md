---
title: ArgoCD VolumeClaimTemplate ignoreDifferences pattern
description: How to prevent ArgoCD drift alerts when StatefulSet VCT entries differ in apiVersion/kind
---

# ArgoCD VolumeClaimTemplate (VCT) ignoreDifferences Pattern

## Memory

- **File paths:** `kubernetes/core/argocd-cm/application.yaml`, `kubernetes/core/openbao/application.yaml`
- **Problem:** StatefulSet VolumeClaimTemplate entries are modified by Kubernetes after creation (adding apiVersion/kind). This causes ArgoCD to report OutOfSync even when nothing changed.
- **Why it matters:** Constant OutOfSync status leads to repeated reconciliation loops, wasted API calls, and user confusion about actual cluster state
- **Solution:** Add `ignoreDifferences` for StatefulSet resources that explicitly ignores `.spec.volumeClaimTemplates[*].apiVersion` and `.spec.volumeClaimTemplates[*].kind`
- **Validation:** After applying, check `kubectl get application <name> -n argocd` — status should be "Synced" with 0 diffs

## Root Cause

When you define a StatefulSet VCT:
```yaml
spec:
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: local-path
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 10Gi
```

After Kubernetes processes it, the VCT includes injected fields:
```yaml
spec:
  volumeClaimTemplates:
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: data
    spec:
      # ... rest of spec
```

ArgoCD's three-way diff compares:
1. Your git manifests (NO apiVersion/kind)
2. Live cluster state (HAS apiVersion/kind)
3. Result: Always shows as different

## Solution Pattern

### For Helm-deployed StatefulSets (via ApplicationSet)

Add to the Application resource's `spec.ignoreDifferences`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: core-openbao
  namespace: argocd
spec:
  # ... other fields
  
  ignoreDifferences:
  - group: "apps"
    kind: StatefulSet
    jqPathExpressions:
    - '.spec.volumeClaimTemplates[*].apiVersion'
    - '.spec.volumeClaimTemplates[*].kind'
    - '.status'
    - '.spec.volumeMode'  # Also ignore volumeMode drift
```

### For Custom Resources with VCTs

Apply same pattern to any resource that has `spec.volumeClaimTemplates`:

```yaml
ignoreDifferences:
- group: ""
  kind: ResourceWithVCT
  jqPathExpressions:
  - '.spec.volumeClaimTemplates[*].apiVersion'
  - '.spec.volumeClaimTemplates[*].kind'
```

## Global Pattern (Kustomize Overlay)

If managing via ArgoCD ConfigMap patching:

```yaml
# argocd-cm in kube-system
data:
  application.instanceLabelKey: argocd.argoproj.io/instance
  # Add global ignoreDifferences via:
  # This is NOT recommended; use Application-level instead
```

**Recommendation:** Use Application-level `ignoreDifferences` (not global). It's clearer, more maintainable, and doesn't affect unrelated resources.

## Validation Checklist

- [ ] Application YAML includes `ignoreDifferences` block
- [ ] `jqPathExpressions` include `.spec.volumeClaimTemplates[*].apiVersion` and `.kind`
- [ ] Also ignore `.status` for general drift (optional but recommended)
- [ ] Apply: `kubectl apply -f application.yaml`
- [ ] Check: `kubectl get application <name> -o jsonpath='{.status.sync.status}'` returns "Synced"
- [ ] Verify: `kubectl diff -f application.yaml` shows no changes

## Testing

```bash
# Before fix: Should show "OutOfSync"
kubectl get application core-openbao -n argocd -o jsonpath='{.status.sync.status}'
# Output: OutOfSync

# After fix with ignoreDifferences:
kubectl get application core-openbao -n argocd -o jsonpath='{.status.sync.status}'
# Output: Synced
```

## Related Issues

- **VCT immutability:** StatefulSet `.spec.volumeClaimTemplates` is immutable; changes require deletion + recreation
- **Helm limitations:** Helm does NOT set apiVersion/kind in templates; Kubernetes injects them
- **OpenBao specific:** OpenBao Helm chart includes 5 retries on StatefulSet update failures; drift causes unnecessary retries
- **PostgreSQL affected:** Standard postgres charts have same issue with PVC templates

## Lesson Learned

ArgoCD's strict diffing can flag "no-op" changes as drift. Use `ignoreDifferences` to suppress expected Kubernetes-injected fields. This is a common pattern for:
- VolumeClaimTemplates (apiVersion/kind injection)
- Status fields (always changing)
- Metadata timestamps (applied, managed-fields)
- Defaulted values (Kubernetes adds defaults during admission)

---

**Related files:**
- `.github/memories/longhorn-iscsiadm-fix.md` — Why Longhorn crashed (helps contextualize VCT drift)
- `kubernetes/core/argocd-cm/` — Contains other ArgoCD customizations
- `kubernetes/core/openbao/application.yaml` — Working example

**Discovered:** 2026-05-26  
**Pattern Status:** ✅ Tested and validated
