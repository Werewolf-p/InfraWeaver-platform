---
title: Talos etcd CP node recovery procedure
description: How to recover a Talos control-plane node when etcd has lost quorum or a member is permanently removed
---

# Talos etcd CP Node Recovery

## Memory

- **File paths:** `.github/workflows/etcd-fix.yml`, Proxmox VMs 9300/9301/9302 on pve-prod1/2/3
- **Decision:** Recovery requires: (1) hard QEMU stop/start for unreachable nodes, (2) manual EPHEMERAL partition wipe for etcd data, (3) letting Talos re-join natively
- **Why it matters:** Using `talosctl reboot` or `qm reset` leaves nodes in TCP-unreachable state (kexec hangs); only `qm stop && qm start` fully recovers them

## Cluster Topology

- pve-prod1 (10.25.0.80): talos-prod-cp1 (VM 9300), prod-runner (VM 9100)
- pve-prod2 (10.25.0.81): talos-prod-cp2 (VM 9301)
- pve-prod3 (10.25.0.82): talos-prod-cp3 (VM 9302)
- Cross-host port 50000 accessibility: pve-prod1↔CP2 OK, pve-prod3↔CP1/CP2 OK, pve-prod1↔CP3 UNRELIABLE

## Critical: Talos Reboot Leaves VMs Unreachable

When Talos uses kexec for reboot (`talosctl reboot`, `talosctl reset --reboot`), the QEMU process does NOT restart — it uses kexec to jump the kernel. This leaves the VM in a state where:
- Ping responds (VM is "running", MAC responds to ARP)
- ALL TCP ports timeout (50000, 6443, 2379, 22, etc.)
- The VM is stuck in a post-kexec limbo state
- `qm reset <vmid>` does NOT fix this
- **Only `qm stop <vmid> && sleep 5 && qm start <vmid>` from the host PVE node fixes it**

```bash
# Fix a stuck Talos node after reboot:
ssh root@<pve-host> "qm stop <vmid> && sleep 5 && qm start <vmid>"
```

## etcd Partition Layout

The Talos disk on these VMs has NO dedicated ETCD partition:
- vda1: STATE (XFS)
- vda2: BIOS boot
- vda3: BOOT (XFS)
- vda4: META
- vda5: EPHEMERAL (XFS) ← etcd data lives here at /var/lib/etcd

**`talosctl reset --system-labels-to-wipe=ETCD` does NOT work** — there is no "ETCD" labeled partition to wipe. It silently does nothing.

## Correct etcd Recovery for Permanently-Removed Member

When a CP node's etcd member was "permanently removed" and the node needs to rejoin:

### Step 1: Ensure the cluster has a healthy leader (CP1+CP3 in our case)
```bash
/tmp/talosctl --nodes 10.25.0.90 etcd members
```

### Step 2: Wipe etcd data by stopping VM and mounting EPHEMERAL partition
```bash
# On the PVE host that owns the VM (pve-prodX):
qm stop <vmid>
DISK=/dev/pve/vm-<vmid>-disk-0
LOOP=$(losetup --find --show --partscan $DISK)
mkdir -p /mnt/cp-ephemeral
mount ${LOOP}p5 /mnt/cp-ephemeral  # p5 is EPHEMERAL
rm -rf /mnt/cp-ephemeral/lib/etcd/member  # wipe ONLY the member dir, not the parent
umount /mnt/cp-ephemeral
losetup -d $LOOP
qm start <vmid>
```

### Step 3: Wait for Talos to auto-join
After CP2 boots with empty `/var/lib/etcd/member`, Talos will:
1. Detect empty etcd data
2. Reach out to existing CP nodes via trustd
3. Request to join the cluster
4. Existing CP node adds the new member and returns cluster config
5. etcd starts with new member ID and syncs

Watch for success:
```bash
talosctl --nodes <cp2-ip> dmesg | grep "successfully promoted etcd member"
```

### Step 4: DO NOT pre-add via etcdctl
Running `etcdctl member add` before Talos auto-joins causes conflicts:
- Talos creates yet another member entry when it does the trustd-based join
- The pre-created "unstarted" member stays orphaned in the cluster
- If you accidentally run etcdctl member add, remove it with `etcdctl member remove <id>` before the VM boots

## Helper: Install etcdctl on pve-prodX
```bash
ETCD_VER=v3.5.21
curl -sL https://github.com/etcd-io/etcd/releases/download/${ETCD_VER}/etcd-${ETCD_VER}-linux-amd64.tar.gz -o /tmp/etcd.tar.gz
tar -xf /tmp/etcd.tar.gz -C /tmp --strip-components=1 etcd-${ETCD_VER}-linux-amd64/etcdctl
chmod +x /tmp/etcdctl
```

etcd certs from CP1 (for etcdctl):
```bash
talosctl --nodes 10.25.0.90 read /system/secrets/etcd/ca.crt > /tmp/etcd-ca.crt
talosctl --nodes 10.25.0.90 read /system/secrets/etcd/server.crt > /tmp/etcd-server.crt
talosctl --nodes 10.25.0.90 read /system/secrets/etcd/server.key > /tmp/etcd-server.key
```

## Validation

```bash
# All 3 members should be "started":
ETCDCTL_API=3 /tmp/etcdctl --endpoints=https://10.25.0.90:2379 \
  --cacert=/tmp/etcd-ca.crt --cert=/tmp/etcd-server.crt --key=/tmp/etcd-server.key \
  member list

# K8s should be healthy:
KUBECONFIG=~/.kube/config-productie kubectl get nodes
```

## Related
- `.github/workflows/etcd-fix.yml` — GitHub Actions workflow for etcd member operations
- `.github/workflows/cluster-recover.yml` — cluster health check workflow
- Proxmox hosts: pve-prod1 (10.25.0.80), pve-prod2 (10.25.0.81), pve-prod3 (10.25.0.82)
- talosctl: `/tmp/talosctl` on pve-prod1 (v1.12.7), talosconfig: `/tmp/talosconfig`
- prod-runner (10.25.0.85, VM 9100 on pve-prod1) has v1.10.9 talosctl

## Lesson Learned
- `talosctl reset --system-labels-to-wipe=ETCD` is a no-op when no ETCD partition exists
- The root cause of cluster instability was a Tailscale DaemonSet with hostNetwork adding nftables rules that affected connectivity after kexec-based reboots
- Cross-host VM connectivity between PVE hosts can be asymmetric/unreliable; always test from the same-host PVE node first
