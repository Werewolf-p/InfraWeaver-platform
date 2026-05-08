---
title: Platform Groups + HA Replicas Architecture
description: ApplicationSet split by tier for optional group enable/disable, replicas from platform.yaml
---

# Platform Groups + HA Replicas Architecture

## Memory

- **File paths:**
  - `platform.yaml` — `core:` (visibility), `groups:` (enable/disable + replicas), `catalog.ha:` (catalog replicas)
  - `kubernetes/bootstrap/appset-core.yaml` — mandatory, scans `kubernetes/core/*/application.yaml`
  - `kubernetes/bootstrap/appset-core-monitoring.yaml` — optional, managed by sync-groups.sh
  - `kubernetes/bootstrap/appset-core-platform.yaml` — optional, managed by sync-groups.sh
  - `kubernetes/bootstrap/applicationset-root.yaml` — renamed to `platform-catalog-apps`, scans `catalog/` and `apps/` only
  - `scripts/sync-groups.sh` — reads platform.yaml, creates/deletes group AppSet files, propagates replicas

- **Decision:** Split the single `platform-apps` ApplicationSet into 4 per-tier AppSets. Mandatory core tier always present; optional groups created/deleted by sync-groups.sh based on platform.yaml `groups.<name>.enabled`.

- **Replicas flow:** `platform.yaml groups.<group>.apps.<app>.replicas` → `sync-groups.sh` writes to `application.yaml` → ApplicationSet template passes as `helm.parameters[replicaCount]` → Kubernetes Deployment replicas.

- **Why it matters:** Different charts use different replica paths. Simple apps use `replicaCount`. Complex apps (kube-prometheus-stack, wazuh) manage replicas in values.yaml instead.

- **Migration gotcha:** When replacing `platform-apps` with the new split AppSets:
  1. Deploy new AppSet files first → old `platform-apps` is OutOfSync in bootstrap
  2. Patch `platform-apps` with `preserveResourcesOnDeletion: true` BEFORE deleting
  3. Delete `platform-apps` → child apps orphaned (not deleted)
  4. Restart `argocd-applicationset-controller` → clears stale ownership cache
  5. New AppSets adopt the orphaned apps

- **Validation:** `scripts/validate-platform-yaml.sh` validates groups.enabled (bool), replicas (positive int), directory existence

- **Related:** `scripts/sync-groups.sh`, `scripts/sync-catalog.sh`, `.github/workflows/apply-changes.yml`
