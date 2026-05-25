---
title: Talos kubelet restart cascade pattern
description: When a Talos node's kubelet restarts, ALL pods on that node get SandboxChanged and restart, causing a 30-60s cascade of flannel/CSI/pod failures that self-heal.
---

# Talos Kubelet Restart Cascade

## Memory

- **File paths:** n/a (cluster behaviour, not a file)
- **Decision:** Accept as expected Talos behaviour; no code fix needed.
- **Why it matters:** Every kubelet restart looks like mass pod failures in dashboards. High restart counters (43x flannel, 152x longhorn-csi, 45x openbao) are all explained by this single pattern — NOT individual pod bugs.

## What happens

1. Talos reconciles machineconfig (or a node is force-restarted via Proxmox)
2. kubelet restarts → `Starting kubelet.` event appears on the node
3. Every pod on that node gets `SandboxChanged` → all pods restart simultaneously
4. flannel restarts first, briefly removes `/run/flannel/subnet.env`
5. During flannel startup (~30s), any pod sandbox creation fails: `failed to load flannel 'subnet.env'`
6. flannel writes subnet.env → all pods recover → cluster is fully healthy again

## Observed pattern

| Node  | Reason for kubelet restart      | Recovery time |
|-------|--------------------------------|---------------|
| cp1   | Force stop/start via Proxmox   | ~90s          |
| cp2   | Talos reconciliation after cp1 | ~30s          |
| cp3   | Talos reconciliation (delayed) | ~30s          |

After cp1 force-restart (VM power cycle via Proxmox API):
- cp1 kubelet restarts immediately
- cp2 restarts ~1 min later (etcd re-election)
- cp3 restarts ~30 min later (Talos next reconciliation window)

## How to distinguish real crashes from this pattern

**Real crash indicators:**
- Pod shows `OOMKilled` reason
- Pod shows `Error` or `CrashLoopBackOff` with non-255 exit code
- ArgoCD apps go `Degraded`
- `kubectl get events -A --field-selector type=Warning` shows `OOMKilling`

**Sandbox cascade (safe to ignore temporarily):**
- `SandboxChanged` events on many pods simultaneously
- `FailedCreatePodSandBox: failed to load flannel subnet.env`
- Exit code 255 (`Unknown` reason) on flannel/longhorn-csi/openbao
- All pods return to Running within 2 minutes

## Validation

```bash
# Is it a sandbox cascade?
kubectl get events -n kube-system --sort-by='.lastTimestamp' | grep SandboxChanged | tail -5
# If many pods show SandboxChanged at the same timestamp → kubelet restart, not individual crash

# Check kubelet restart time
kubectl get events --all-namespaces --sort-by='.lastTimestamp' | grep "Starting kubelet"
```

## Related

- `.github/memories/flannel-transient-failures.md` — the flannel side of this pattern
- Proxmox API force-restart script (used in session to recover cp1)
