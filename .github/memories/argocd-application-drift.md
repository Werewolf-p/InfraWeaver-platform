# ArgoCD Application Annotation Drift — Permanent Pattern

## What causes it
Two annotations are mutated at runtime on ArgoCD `Application` resources:
- `notified.notifications.argoproj.io` — written by the notifications controller with timestamps on every notification send
- `kubectl.kubernetes.io/last-applied-configuration` — added by kubectl apply

For bootstrap-managed Application resources, these cause **perpetual OutOfSync** drift.

## Additional complication: bootstrap is owned by platform ApplicationSet
The `platform` ApplicationSet (OpenTofu-managed, label `app.kubernetes.io/managed-by: opentofu`)
generates ALL top-level apps including `bootstrap`. Any live patch to `bootstrap.spec.ignoreDifferences`
is **immediately reverted** by the ApplicationSet controller. You cannot fix this per-app.

## The fix (already applied globally)
`kubernetes/core/argocd/values.yaml` contains:
```yaml
resource.customizations.ignoreDifferences.argoproj.io_Application: |
  jsonPointers:
    - /metadata/annotations/notified.notifications.argoproj.io
    - /metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration
```

## Key rule
**Never attempt to add `ignoreDifferences` to the `bootstrap` Application spec directly** — the `platform`
ApplicationSet will revert it within seconds. Always use the global `resource.customizations.ignoreDifferences.*`
approach in `argocd-cm` (via `kubernetes/core/argocd/values.yaml`).

## When apps still show OutOfSync
- Check if the drift is caused by a runtime-mutated annotation → add to global ignoreDifferences
- Check if drift is a zero-value bool (e.g., `recurse: false`) → remove the field from git entirely
- Check if drift is a Kubernetes-injected VCT field → see argocd-vct-drift-pattern.md
