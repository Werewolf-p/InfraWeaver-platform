---
title: Talos image cache corruption causes VM boot loop
description: Corrupted cached Talos raw image passes size check but has corrupt ZSTD initramfs — VMs boot-loop silently
---

# Talos Image Cache Corruption

## Memory

- **File paths:**
  - `terraform/modules/talos-cluster/main.tf` — `null_resource.download_talos_image`
  - `/tmp/talos-v1.12.7.raw` — cached image on Proxmox host (persists across reboots if /tmp is tmpfs-backed but survives otherwise)
  - `/tmp/talos-v1.12.7.raw.sha256` — SHA256 sidecar (added by fix)

- **Decision:** Added SHA256 sidecar file alongside the cached `.raw` image. After every fresh download, write `sha256sum` output to `.sha256`. On subsequent runs, if size ≥ 4 GB, verify SHA256 before using cache. On mismatch, force re-download.

- **Why it matters:** The old size-only check (`>= 4 GB`) passed for a corrupted 4.2 GB image. Every redeploy reused the corrupt image. VMs booted GRUB → Talos initramfs → kernel reported `ZSTD-compressed data is corrupt` → `failed to mount squashfs` → reboot loop. Port 50000 never opened. `start_and_configure_talos` provisioner timed out after 40 × 15s = 10 min per node. This caused 4 consecutive full-redeploy failures.

- **Symptom:** Workflow error: `"ERROR: Could not find Talos API for talos-prod-cp1 on 10.10.0.0/24"`. VMs show as `running` in `qm list` but have no ARP presence on VLAN3. Serial console (`socat -u UNIX-CONNECT:/var/run/qemu-server/9310.serial0`) shows `[talos] [initramfs] rebooting in N seconds`.

- **Diagnosis steps:**
  1. SSH to Proxmox: `qm list` → VMs running
  2. `timeout 3 socat -u UNIX-CONNECT:/var/run/qemu-server/9310.serial0 /dev/stdout` → see reboot countdown
  3. Longer capture (25s) → see full boot sequence + error message
  4. Verify: `mount -o loop,offset=$((4306944*512)) /tmp/talos-v1.12.7.raw /mnt && zstd -t /mnt/A/initramfs.xz` → `Decoding error (36): Restored data doesn't match checksum`

- **Recovery:** `rm /tmp/talos-v1.12.7.raw /tmp/talos-v1.12.7.raw.sha256` on the Proxmox host, then re-run the redeploy workflow. The download provisioner re-downloads fresh.

- **Validation:** After fix, VMs show `REACHABLE` ARP on VLAN3 and port 50000 is open within ~3 minutes of VM start.

- **Related:** `start_and_configure_talos` provisioner (main.tf line ~477), `download_talos_image` (main.tf line ~68)

- **Lesson learned:** File integrity checks must go beyond file size — ZSTD/XZ images can be large but internally corrupt. SHA256 sidecar is the minimum viable integrity check for cached binary artifacts.
