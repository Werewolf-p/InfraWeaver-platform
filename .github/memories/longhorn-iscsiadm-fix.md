---
title: Longhorn CSI crashes due to missing iscsiadm
description: Longhorn requires open-iscsi (iscsiadm) installed on cluster nodes; Talos doesn't include it by default
---

# Longhorn iscsiadm Dependency Issue

## Memory

- **File paths:** `kubernetes/n8n-blueprints/`, `.env` (ENABLE_LONGHORN toggle)
- **Decision:** Disable Longhorn in lightweight clusters without iscsiadm; use local-path storage instead
- **Why it matters:** Longhorn manager checks for iscsiadm on startup; missing it causes 30+ CSI pods to CrashLoopBackOff, impacting all services
- **Validation:** Check `kubectl get pods -n longhorn-system` after toggling; no CrashLoopBackOff = success
- **Related:** Talos v1.13, Kubernetes 1.35.4, local-path-retain StorageClass
- **Lesson learned:** Longhorn is heavyweight; not suitable for control-plane-only clusters without extra dependencies

## Root Cause

Longhorn manager pod runs:
```bash
/usr/bin/nsenter [nsenter --mount=/host/proc/<PID>/ns/mnt --net=/host/proc/<PID>/ns/net iscsiadm --version]
```

On Talos nodes, `iscsiadm` is not installed → `exit status 127: No such file or directory` → pod crashes → CrashLoopBackOff.

## Solution Implemented

1. **Disable via environment:** `ENABLE_LONGHORN=false` in `.env`
2. **ArgoCD skips deployment:** Application manifests respect `ENABLE_LONGHORN` feature flag
3. **Use local-path storage:** Already has `local-path-retain` StorageClass with Retain policy
4. **No impact to n8n:** n8n deployment uses emptyDir (ephemeral), doesn't depend on Longhorn

## Fix Instructions

```bash
# In .env file:
ENABLE_LONGHORN=false

# Then delete crashing namespace:
kubectl delete namespace longhorn-system

# Verify cleanup:
kubectl get pods --all-namespaces | grep -i longhorn
# Should return 0 results
```

## Testing

```bash
# Before: ~30 CrashLoopBackOff pods
kubectl get pods -n longhorn-system | grep CrashLoopBackOff | wc -l

# After deletion:
kubectl get pods -n longhorn-system 2>&1
# Error from server (NotFound): namespaces "longhorn-system" not found
```

## Alternative: Install iscsiadm on Talos

If Longhorn is required for persistent storage:

1. Update Talos MachineConfig to install open-iscsi
2. Apply: `talosctl apply -f machineconfig.yaml`
3. Restart nodes
4. Re-enable Longhorn: `ENABLE_LONGHORN=true`

**Note:** Talos doesn't persist container image updates; requires Kubernetes upgrade or manual node rebuild.

## Feature Flag Pattern

The `.env` variable `ENABLE_LONGHORN` is read by `terraform/` and `kubernetes/` deployments:
- `ENABLE_LONGHORN=true` → deploy Longhorn app (requires iscsiadm)
- `ENABLE_LONGHORN=false` → skip Longhorn, use local-path only

Similar pattern: `ENABLE_KYVERNO`, `ENABLE_WAZUH` for optional components.

---

**Discovered:** 2026-05-26  
**Cluster:** Talos v1.13.0, Kubernetes 1.35.4  
**Workaround verified:** ✅ Cluster stable after Longhorn namespace deletion
