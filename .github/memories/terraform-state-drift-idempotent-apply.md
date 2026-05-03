---
title: Terraform state drift — idempotent apply with pre-flight imports
description: How to make tofu apply idempotent when cluster exists but state is stale (e.g. after runner VM recreation)
---

# Terraform State Drift — Idempotent Apply

## Memory

- **File paths:** `.github/workflows/platform.yml` (Deploy Platform step), `terraform/modules/platform-bootstrap/main.tf`
- **Decision:** Pre-flight `tofu import` block runs before `tofu apply` Stage 2, importing all known already-existing resources into state — no-ops if already in state.
- **Why it matters:** The runner uses local Terraform state (`~/.tofu/state/platform-<env>/terraform.tfstate`). If the runner VM is recreated or state is lost, `tofu apply` fails with "already exists" errors because the real cluster is fully running but state is empty.

## Cascading Errors (in order of appearance)

| Error | Cause | Fix |
|---|---|---|
| `namespace "argocd" already exists` | `kubernetes_namespace.argocd` not in state | Import it |
| `cannot re-use a name that is still in use` for helm_release.argocd | Helm release exists but not in state | Import it (`argocd/argocd` format) |
| `Provider produced inconsistent final plan` on AppProject | ArgoCD controller adds `spec.syncWindows[*].andOperator/description` computed fields after creation — provider can't match them | Add `computed_fields` to `kubernetes_manifest` resource |

## Pre-flight Import Pattern (in platform.yml)

```bash
import_if_missing() {
  local ADDR=$1 ID=$2
  if ! tofu state show "$ADDR" > /dev/null 2>&1; then
    echo "  Importing ${ADDR} (id=${ID})..."
    tofu import $VARS "$ADDR" "$ID" 2>&1 || echo "  WARN: import failed for ${ADDR}"
  else
    echo "  ✅ ${ADDR} already in state — skip import"
  fi
}

CLUSTER_NAME=$(grep 'cluster_name' "../envs/$ENV/terraform.tfvars" | sed 's/.*= *"\(.*\)"/\1/')
ARGOCD_NS="argocd"

import_if_missing "module.platform_bootstrap[0].kubernetes_namespace.argocd" "$ARGOCD_NS"
import_if_missing "module.platform_bootstrap[0].helm_release.argocd" "${ARGOCD_NS}/argocd"
import_if_missing "module.platform_bootstrap[0].kubernetes_manifest.app_project" \
  "argoproj.io/v1alpha1/AppProject/${ARGOCD_NS}/${CLUSTER_NAME}"
import_if_missing "module.platform_bootstrap[0].kubernetes_manifest.platform_applicationset" \
  "argoproj.io/v1alpha1/ApplicationSet/${ARGOCD_NS}/platform"
```

## Import ID Formats

| Resource type | Import ID format | Example |
|---|---|---|
| `kubernetes_namespace` | `<namespace-name>` | `argocd` |
| `helm_release` | `<namespace>/<release-name>` | `argocd/argocd` |
| `kubernetes_manifest` (namespaced) | `<apiVersion>/<kind>/<namespace>/<name>` | `argoproj.io/v1alpha1/AppProject/argocd/infraweaver-prod` |
| `kubernetes_manifest` (cluster-scoped) | `<apiVersion>/<kind>/<name>` | `argoproj.io/v1alpha1/ClusterRole/my-role` |

## computed_fields Pattern for ArgoCD CRDs

ArgoCD's controller mutates resources after creation, adding computed fields the provider doesn't know about:

```hcl
resource "kubernetes_manifest" "app_project" {
  computed_fields = [
    "metadata.annotations",
    "metadata.labels",
    "spec.syncWindows",   # ArgoCD adds these even when empty
    "spec.roles",
    "spec.orphanedResources",
  ]
  manifest = { ... }
}

resource "kubernetes_manifest" "platform_applicationset" {
  computed_fields = [
    "metadata.annotations",
    "metadata.labels",
    "status",             # ApplicationSet status is fully managed by controller
  ]
  manifest = { ... }
}
```

## lifecycle.ignore_changes for Namespace

```hcl
resource "kubernetes_namespace" "argocd" {
  lifecycle {
    ignore_changes = [
      metadata[0].labels,
      metadata[0].annotations,
    ]
  }
}
```
Controllers (e.g., kube-system, ArgoCD) add labels and annotations to namespaces — ignoring them prevents spurious plan diffs.

## Validation

- Run triggers: push to `terraform/**` or `envs/**` on an already-running cluster
- All 3 Deploy jobs should pass: Plan ✅, Security Gate (skipped on push), Deploy ✅
- Check step output: "✅ X already in state — skip import" means idempotent path was taken

## Long-term Fix

The root cause is local state. Proper fix: migrate to remote state backend (S3/Minio or PostgreSQL via `pg` backend). See todo `A4`. Until then, the pre-flight import pattern is the resilience mechanism.

## Lesson Learned

- `helm_release` import ID is `namespace/release-name`, NOT just `release-name`  
- `kubernetes_manifest` for CRD-backed resources (AppProject, ApplicationSet) often needs `computed_fields` because controllers mutate the resource post-creation
- `time_sleep` resources cannot be imported — they'll be re-created, which is harmless (just causes a 30s delay)
- **Always add `computed_fields` to any `kubernetes_manifest` resource that uses a custom CRD managed by an operator**
