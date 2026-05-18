---
title: "Can't connect to this VM" — root cause chain
description: Why the management host / console become unreachable periodically, and how to diagnose it in under 60 seconds.
---

# Connectivity Failure Root Causes

## The Three Failure Modes

### Mode 1 — pve-prod1 OOM Kill (PRIMARY, most common)
**Symptom:** `ssh 10.25.0.85` (prod-worker / runner) times out. `ssh 10.25.0.90` (CP1) times out.
**Root cause:** The main Proxmox host (10.25.0.3) allocates ~95 GB RAM across all VMs vs 62 GB physical. The Linux OOM killer fires and terminates pve-prod1 (16 GB QEMU process = largest single allocation). pve-prod1 hosts:
- `10.25.0.85` — prod-worker (GitHub self-hosted runner + management shell)
- `10.25.0.90` — talos-prod-cp1 (K8s control plane node 1)
- `10.25.0.86` — OpenBao (secrets engine)

**Duration:** 2-5 minutes. pve-prod1 restarts via QEMU watchdog; nested VMs auto-start via `onboot`.
**Detection:** `qm list | grep 180` on main Proxmox shows `stopped`.
**Recovery:** `ssh root@10.25.0.3` then `qm start 180`
**Cascade:** K8s loses 1/3 CP nodes, Flannel on CP1 dies (exit 255), pods on CP1 restart, GitHub runner offline, ArgoCD sync may pause.

### Mode 2 — NetBird VPN Disruption
**Symptom:** SSH to `10.25.0.85` works, but `*.int.rlservers.com` domains unreachable. VPN appears connected but traffic drops.
**Root cause:** NetBird relay / signal / dashboard (on cp2) restart when cp2 has a churn event. They restart ~61x per 3 days. NetBird management (StatefulSet, cp3) has a Longhorn PVC dependency — when cp3 has a node event, Longhorn CSI re-attach takes 60-120 s. During this window new WireGuard handshakes fail.
**Detection:** `kubectl get pods -n netbird` — any pod not `1/1 Running`.
**Recovery:** If management is stuck `Init:0/2` looping `OIDC endpoint not ready`, wait for Authentik to stabilise. If pod is `Terminating`, force-delete: `kubectl delete pod netbird-management-0 -n netbird --force --grace-period=0`

### Mode 3 — MetalLB VIP Failover
**Symptom:** `infraweaver.int.rlservers.com` returns connection refused for 30-90 s, then self-heals.
**Root cause:** MetalLB L2 announcement for VIP `10.10.0.200` switches between nodes when a speaker pod restarts. MetalLB speakers accumulate ~170 restarts per pod over 8 days (one restart per hour on average, correlated with pve-prod OOM events).
**Detection:** `kubectl get events -n metallb-system | grep nodeAssigned` — watch for rapid node switching.
**Recovery:** Self-heals in 30-90 s. If persistent: `kubectl get pods -n metallb-system` for stuck speakers.

## 60-Second Diagnostic

```bash
# 1. Is prod-worker alive?
ssh -o ConnectTimeout=5 10.25.0.85 echo ok 2>/dev/null && echo "worker: UP" || echo "worker: DOWN — pve-prod1 OOM killed, run: ssh root@10.25.0.3 then: qm start 180"

# 2. Are K8s nodes healthy?
kubectl get nodes

# 3. Is NetBird management up?
kubectl get pods -n netbird

# 4. Is MetalLB stable?
kubectl get pods -n metallb-system | grep -v Running
```

## Why It Happens — Proxmox Overcommit

| VM | Allocated RAM |
|----|--------------|
| pve-prod1 | 16 GB |
| pve-prod2 | 16 GB |
| pve-prod3 | 16 GB |
| TrueNAS | 16 GB |
| Windows-Server-2025 | 8 GB |
| github-runner | 8 GB |
| Traefik+AdGuard | 6 GB |
| Backup-server | 8 GB |
| **Total allocated** | **~95 GB** |
| **Physical RAM** | **62 GB** |

**The real fix:** Reduce total VM RAM allocation to under 55 GB (leave ~7 GB for ZFS ARC + kernel).
Quick wins: reduce Windows-Server-2025 to 4 GB if idle, reduce each pve-prod VM to 12 GB.

## Flannel Restart Count = OOM Counter
All Flannel DaemonSet pods accumulate exit-code-255 restarts together (~170+ per pod over 8 days).
Exit 255 = container killed during node shutdown (not a Flannel bug).
This count is a reliable proxy for total pve-prod OOM crash frequency.
