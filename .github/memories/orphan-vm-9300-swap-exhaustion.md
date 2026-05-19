---
title: Orphan VM 9300 causing swap exhaustion on Proxmox host
description: A zombie QEMU process (old talos-prod-cp1) stuck in D-state is consuming 5.7GB of the 6.1GB swap
---

# Orphan VM 9300 — Swap Exhaustion Root Cause

## Memory

- **VM ID:** 9300 (old talos-prod-cp1, replaced by 9310)
- **PID:** 37218 on Proxmox host 10.25.0.3
- **State:** D (uninterruptible sleep) — stuck in `io_wq_put_and_exit` since April 28
- **Impact:** 5.7GB swap + 1.4GB RAM consumed. This is the root cause of 100% swap
  usage on the Proxmox host, NOT the Talos nodes themselves.
- **Why it is stuck:** Block device `/dev/Storage/vm-9300-disk-0` was deleted when VM 9300
  was decommissioned, but the QEMU process was never properly stopped first. The process
  is stuck waiting for io_uring operations to drain against a device that no longer exists.
- **Workaround applied:** Created dummy LVM volume `vm-9300-disk-0` in Storage VG (4MB thin).
  Did NOT unblock the process — it remained in D-state.
- **Kill -9 result:** kill -9 37218 does not work on D-state processes.

## Fix Required

Requires a full Proxmox host reboot — the only way to kill a D-state process.

After reboot run on Proxmox host:
```bash
lvremove -f /dev/Storage/vm-9300-disk-0   # remove the dummy volume created as workaround
qm list                                     # verify no VM 9300 appears
```

## Prevention

When decommissioning a VM in Proxmox, always stop the VM before deleting its disk.
If the disk is deleted while QEMU is running, the QEMU process can enter D-state permanently.

Check for orphan QEMU processes after any VM deletion:
```bash
ps aux | grep kvm | grep -oP '(?<=-id )\d+' | while read vmid; do
  qm status $vmid 2>/dev/null || echo "ORPHAN vmid=$vmid"
done
```

Check for swap-heavy QEMU processes:
```bash
for pid in $(ls /proc | grep '^[0-9]'); do
  swap=$(grep VmSwap /proc/$pid/status 2>/dev/null | awk '{print $2}')
  name=$(cat /proc/$pid/comm 2>/dev/null)
  [ -n "$swap" ] && [ "$swap" -gt 1048576 ] && echo "PID $pid ($name): ${swap}kB swap"
done
```

## Related

- Proxmox host: 10.25.0.3
- Storage VG: `/dev/Storage/`
- VM 9300 was the original VMID for talos-prod-cp1, later renumbered to 9310
- Session where discovered: 2026-05-19 during community app memory relief work
