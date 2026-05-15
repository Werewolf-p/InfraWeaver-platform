---
title: Config audit May 2026
description: Cluster config audit, fixes applied, and remaining external stability blocker
---

# Config Audit — 2026-05-15

## Repo changes pushed
- `fix(config): comprehensive cluster config fixes` (`4dd36b1` on `main` after push)
- Files changed:
  - `kubernetes/bootstrap/appset-core-monitoring.yaml`
  - `kubernetes/catalog/infraweaver-api/manifests/deployment.yaml`
  - `kubernetes/catalog/onedev/manifests/resources.yaml`
  - `kubernetes/platform/authentik/values.yaml`
  - `scripts/sync-groups.sh`

## Fixes applied

### 1) monitoring-kube-prometheus-stack drift / bundled Grafana leftovers
**Problem:** `monitoring-kube-prometheus-stack` stayed `OutOfSync` after `grafana.enabled=false` because the monitoring appset had `automated.prune: false`.

**Fix:**
- Changed `scripts/sync-groups.sh` so `core-monitoring` appsets generate with `prune: true`
- Updated `kubernetes/bootstrap/appset-core-monitoring.yaml` accordingly
- Manually pruned the orphaned monitoring resources that ArgoCD still listed as `requiresPruning`
  - Grafana PVC / Service / Ingress / RBAC / ServiceMonitor
  - legacy dashboard ConfigMaps

**Result:** `monitoring-kube-prometheus-stack` returned to `Synced / Healthy` and node memory dropped materially afterward.

### 2) infraweaver-api probe hardening
**Problem:** API pods had very aggressive 1s probe timeouts and no startup probe.

**Fix:**
- Added `startupProbe`
- Increased readiness/liveness `timeoutSeconds` to `5`
- Increased liveness `failureThreshold` to `5`
- Delayed liveness start to reduce false restarts during rollouts/restarts

**Result:** New probe settings landed in-cluster and the deployment rolled out successfully.

### 3) OneDev readiness tuning
**Problem:** OneDev showed readiness failures during slow start.

**Fix:**
- Increased readiness initial delay `60 -> 90`
- Increased readiness timeout `5 -> 10`
- Increased readiness failure threshold `3 -> 5`
- Increased liveness initial delay `90 -> 120`

**Result:** Deployment rolled out with the new probe settings.

### 4) Authentik probe timeout tuning
**Problem:** Authentik worker/server probes were still using 3s timeouts and produced false negatives during startup/load.

**Fix:**
- Added `startupProbe.timeoutSeconds: 10`
- Set server/worker readiness and liveness `timeoutSeconds: 10`

**Result:** Updated probe values reached the live deployments.

## Manual Longhorn recovery work performed

### Stale replica cleanup
**Problem:** After CP1 reboot, Longhorn kept stale `stopped` replicas on `talos-prod-cp1`, producing `no route to host` rebuild errors against dead replica IPs.

**Actions taken:**
- Deleted the stale stopped `replica.longhorn.io` objects on CP1
- Deleted released PV `pvc-c481d9c3-1c17-44a4-a40a-eb19968f0311` (`wiki/wiki-postgresql`) and its orphan Longhorn volume to reduce scheduling inflation

### Temporary rebuild acceleration
**Attempted:**
- `concurrent-replica-rebuild-per-node-limit: 2`
- `replica-replenishment-wait-interval: 30`

**Outcome:**
- This caused extra rebuild churn / engine instability while nodes were still rebooting
- Settings were restored to safer values:
  - `concurrent-replica-rebuild-per-node-limit: 1`
  - `replica-replenishment-wait-interval: 1800`

## Critical remaining blocker (NOT fixed in repo)

### Control-plane node reboots are still occurring outside normal app config changes
Observed during the post-fix stability watch:
- `talos-prod-cp1` rebooted (`Rebooted` event at ~18:35 UTC)
- `talos-prod-cp3` rebooted (`Rebooted` event at ~18:44 UTC)

This reintroduced:
- Longhorn degraded / unknown volumes
- transient app `Progressing/Degraded`
- CSI attach / detach churn
- transient `NodeNotReady` warnings

### Important note
This is **not** caused by the repo config changes made in this audit:
- kube-apiserver pod limits are already present in-cluster at:
  - requests: `512Mi`
  - limits: `4500Mi`
- That means the earlier “no apiserver memory limit” root cause has already been addressed

### Most likely remaining root-cause classes
Needs Talos / VM-host investigation outside normal Kubernetes manifest edits:
- host / VM reboot on the Proxmox side
- Talos node-level crash / reboot cause
- storage / Longhorn instability secondary to node reboot

## Useful commands for next session
```bash
kubectl get events -A --field-selector involvedObject.kind=Node --sort-by=.lastTimestamp | tail -20
kubectl get volumes -n longhorn-system
kubectl get replica.longhorn.io -n longhorn-system | grep stopped
kubectl top pods -n kube-system | grep kube-apiserver
```

## Bottom line
Repo-level configuration drift and probe issues were fixed and pushed.
The cluster did improve temporarily, but the environment is still subject to control-plane node reboots that require Talos / host-level remediation before the cluster can remain fully clean.
