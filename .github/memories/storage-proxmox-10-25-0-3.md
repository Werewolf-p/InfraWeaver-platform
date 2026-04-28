---
title: Proxmox 10.25.0.3 uses lvm-proxmox not local-lvm
description: The main Proxmox node at 10.25.0.3 uses lvm-proxmox as its VM disk storage
---

# Proxmox Storage: 10.25.0.3 uses lvm-proxmox

## Memory

- **Node:** 10.25.0.3 (node name: `proxmox`)
- **Decision:** All VM disk storage must use `lvm-proxmox`, NOT `local-lvm`
- **Why it matters:** `local-lvm` does not exist on 10.25.0.3. Using it causes `storage 'local-lvm' does not exist` errors at apply time via `qm importdisk`
- **Affected files:**
  - `envs/productie/cluster.yaml` — `datastore:` and `talos_image_datastore:`
  - `envs/productie/services.auto.tfvars` — `storage:` and `disk_datastore:`
- **Validation:** `pvesm status` on 10.25.0.3 shows `lvm-proxmox` as the LVM-thin pool
- **Related:** The pve-prod1/2/3 nodes (created by base) also used `lvm-proxmox` for their VM disks
- **Lesson learned:** `local-lvm` is the standard Proxmox default, but 10.25.0.3 was set up with custom `lvm-proxmox` storage name
