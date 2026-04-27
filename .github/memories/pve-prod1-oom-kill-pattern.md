---
title: pve-prod1 OOM kill — causes, symptoms, and fix
description: The main Proxmox host (10.25.0.3) is massively overcommitted (~95+ GB allocated vs 62GB physical). pve-prod1 is periodically OOM-killed, crashing all its nested VMs.
---

# pve-prod1 OOM Kill Pattern

## Memory

- **File paths:** Main Proxmox: 10.25.0.3, pve-prod1: VM 180 (16GB)
- **Decision:** pve-prod1 must be manually restarted with `qm start 180` after OOM kill. All nested VMs auto-start via Proxmox `onboot` setting.
- **Why it matters:** When pve-prod1 dies, OpenBao, prod-worker (github-runner), and CP1 all become unreachable simultaneously. This breaks K8s quorum (1/3 CPs down) and ESO sync.

## Symptoms

- SSH to `10.25.0.80` (pve-prod1) times out
- SSH to `10.25.0.85` (prod-worker/github-runner) times out
- SSH to `10.25.0.86` (OpenBao) times out
- SSH to `10.25.0.90` (CP1) times out
- BUT: 10.25.0.91 (CP2) and 10.25.0.92 (CP3) still work (on pve-prod2/3)
- On main Proxmox: `qm list | grep 180` shows `stopped`
- `ip link show | grep tap180i0` returns nothing (tap interface gone)

## Root Cause

The main Proxmox host allocates more RAM than it has:

| VM | RAM |
|----|-----|
| pve-prod1 | 16GB |
| pve-prod2 | 16GB |
| pve-prod3 | 16GB |
| TrueNAS | 16GB |
| Windows-Server-2025 | 8GB |
| github-runner | 8GB |
| Traefik+AdGuard | 6GB |
| Backup-server | 8GB |
| **Total allocated** | **~95GB** |
| **Physical RAM** | **62GB** |

When memory pressure is high enough, the Linux OOM killer terminates the largest QEMU process — which is pve-prod1 at 16GB.

## Recovery Steps

```bash
# 1. SSH to main Proxmox
ssh -i ~/.ssh/deployer_ed25519 root@10.25.0.3

# 2. Verify pve-prod1 is stopped
qm list | grep 180

# 3. Start it
qm start 180

# 4. Wait ~90s for pve-prod1 to boot
sleep 90

# 5. Check pve-prod1 is up and its VMs are running
ssh root@10.25.0.80 "qm list"
# Expected: 9100 running, 9200 running, 9300 running

# 6. OpenBao auto-unseals via systemd service automatically
# But verify:
ssh -i ~/.ssh/deployer_ed25519 ubuntu@10.25.0.86 \
  "VAULT_ADDR=http://localhost:8200 /usr/bin/bao status | grep Sealed"
# Should show: Sealed false
```

## After Recovery

- OpenBao will be unsealed automatically (openbao-unseal.service enabled)
- K8s cluster remains intact (CP2+CP3 maintained quorum)
- ESO ClusterSecretStore recovers automatically once OpenBao is unsealed
- prod-worker/github-runner restarts — any running GitHub Actions jobs will be lost
- CP1 may need etcd recovery if it was mid-write (see `talos-etcd-recovery.md`)

## Main Proxmox Memory Check

```bash
ssh root@10.25.0.3 "free -h; swapon --show"
```

- **Danger zone:** swap > 4GB used or free < 2GB
- **Normal range (productie active):** ~48-58GB used, 0-3GB swap

## Preventing Future OOM Kills

Options (not yet implemented):
1. Stop non-essential VMs (Windows-server-2025, TrueNAS) during productie deploys
2. Add cgroups memory reservation to protect pve-prod1 QEMU process
3. Use KVM memory ballooning with minimum reservation on nested VMs
4. Reduce TrueNAS allocation (it rarely uses all 16GB)

## Lesson Learned

- The OOM kill manifested as "OpenBao token 403 errors" — misleading; actual issue was sealed vault from OOM crash
- After pve-prod1 restarts, ALL nested VMs (9100, 9200, 9300) autostart via Proxmox `onboot` config
- pve-prod1 boot takes ~90s from `qm start 180` to SSH accessible
