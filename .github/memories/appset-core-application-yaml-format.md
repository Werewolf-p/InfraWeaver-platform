---
title: platform-core ApplicationSet — application.yaml must be a parameter file
description: The appset-core.yaml uses Go templates; application.yaml must provide template variables, not a full ArgoCD Application manifest.
---

# platform-core AppSet: application.yaml format

## Memory

- **File paths:** `kubernetes/bootstrap/appset-core.yaml`, `kubernetes/core/*/application.yaml`, `kubernetes/core/*/values.yaml`
- **Decision:** Each `kubernetes/core/<app>/application.yaml` must be a **flat YAML parameter file** with keys matching the AppSet Go template variables — NOT a full ArgoCD Application manifest.
- **Required fields:**
  ```yaml
  repoURL: https://charts.example.com/charts
  targetRevision: "v1.*"
  chart: my-chart
  releaseName: my-release
  namespace: my-namespace
  # optional:
  replicas: "2"
  serverSideApply: "false"
  ```
- **Why it matters:** The AppSet uses `missingkey=zero` — missing fields become `<no value>` in the generated App spec. A full ArgoCD manifest (with `apiVersion`, `kind`, `spec`) has none of these top-level fields, so ALL template vars resolve to `<no value>`, producing a broken `sources` block with empty repoURL/chart/targetRevision. This creates a `ComparisonError` that causes the bootstrap app to show OutOfSync every refresh — triggering hourly self-healer Discord notifications.
- **Validation:** After pushing fix, `kubectl get app <name> -n argocd -o jsonpath='{.spec.source.repoURL}'` should return the actual Helm chart URL (not empty).
- **Related:** `scripts/sync-groups.sh` regenerates `appset-core.yaml` — if re-run it will overwrite the template; verify after re-runs.
- **Lesson learned:** The `csi-driver-smb` app had a full Application manifest in `application.yaml`. This caused the `platform-core` AppSet to generate a broken multi-source App with `<no value>` for all Helm fields, creating a permanent ComparisonError. Fix: replace with parameter file + separate `values.yaml`.
