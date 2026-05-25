# ArgoCD StatefulSet VCT Drift — Permanent Pattern

## What happens
When a StatefulSet is created, Kubernetes injects these fields into every `volumeClaimTemplate` entry:
- `apiVersion: v1`
- `kind: PersistentVolumeClaim`
- `spec.volumeMode: Filesystem`
- `status.phase: Pending` (and other status fields)

These fields are NOT in git manifests, so ArgoCD sees them as drift and marks the app OutOfSync.
Since VCTs are **IMMUTABLE**, ArgoCD can also never apply changes to them — it will fail with:
```
StatefulSet.apps "X" is invalid: spec: Forbidden: updates to statefulset spec for fields other than
```

## The fix (already applied globally)
`kubernetes/core/argocd/values.yaml` contains a global `ignoreDifferences` for all StatefulSets:

```yaml
resource.customizations.ignoreDifferences.apps_StatefulSet: |
  jqPathExpressions:
    - '.spec.volumeClaimTemplates[].status'
    - '.spec.volumeClaimTemplates[].spec.volumeMode'
    - '.spec.volumeClaimTemplates[].apiVersion'
    - '.spec.volumeClaimTemplates[].kind'
```

This is also patched live to `argocd-cm` so it takes effect immediately without waiting for ArgoCD sync.

## When writing StatefulSet manifests
- Do NOT add `apiVersion:`, `kind:`, `volumeMode:`, or `status:` to VCT entries — they will be ignored anyway
- Do NOT attempt to change VCTs after initial deployment — delete and recreate the StatefulSet if needed
- ArgoCD ignoreDifferences applies globally, no per-app configuration needed

## Affected apps that had this issue
- `catalog-onedev-manifests` (postgres StatefulSet) — fixed in `effcbe06`
- `core-openbao` (openbao StatefulSet) — covered by global ignoreDifferences
- Any future StatefulSet deployment — covered automatically
