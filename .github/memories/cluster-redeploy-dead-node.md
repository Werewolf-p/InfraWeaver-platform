---
title: Cluster redeploy lessons — pve-prod1 offline bypass
description: How to redeploy the platform cluster when pve-prod1 is offline
---

# Cluster Redeploy with Dead Node

## Memory

- **File paths:**
  - `platform/envs/productie/cluster.yaml` — proxmox_host + node assignments
  - `platform/.github/workflows/full-redeploy.yml` — CI pipeline

- **Decision:** When pve-prod1 is offline, change TWO things in cluster.yaml:
  1. `proxmox_host: "10.25.0.81"` — Proxmox API connects through any live cluster node
  2. `talos-prod-cp1.proxmox_node: "pve-prod2"` — move cp1 off dead node

- **Why it matters:** The Terraform proxmox provider hits `${proxmox_host}:8006` for ALL
  API calls (including creating VMs on other nodes). If this host is down, everything fails.
  Proxmox cluster API is accessible through ANY member node.

- **Stale VMID gotcha:** After pve-prod1 goes offline, its VM configs remain in pmxcfs.
  If you try to recreate VMID 9300 (which was on pve-prod1), Proxmox will return
  "No route to host" because it routes the VMID to pve-prod1.
  Fix: `rm /etc/pve/nodes/pve-prod1/qemu-server/9300.conf` from any live node.

- **Validation:** `pvesh get /cluster/resources --type vm` — confirm VMID not listed
- **Revert when pve-prod1 returns:** Set `proxmox_host: "10.25.0.80"` and reassign cp1 back to pve-prod1

## talosctl AMD64 v2 Issue

- **Problem:** The management-host runner VM (10.25.0.108) has a conservative CPU type
  (likely kvm64) that lacks SSE4.2/popcnt. talosctl v1.7+ requires AMD64 v2 (GOAMD64=v2).
  
- **Error:** `This program can only be run on AMD64 processors with v2 microarchitecture support.`

- **Fix in workflow:** Test talosctl first; if it fails, rebuild from source via Docker
  with `GOAMD64=v1`. The binary at `/usr/local/bin/talosctl` gets replaced by the v1 build.
  Binary is cached between runs — Docker build only runs once.

- **Long-term fix:** Change management-host VM CPU type to `host` in Proxmox to expose
  all physical CPU features. Find the VM config in pmxcfs and change `cpu: kvm64` → `cpu: host`.
  Then power-cycle the VM.

## Split-DNS on This Machine

- **Problem:** This machine (10.25.0.108) IS the dnsmasq DNS server. NetBird pushes
  "use 10.25.0.108:53 for rlservers.com" to all peers. But NetBird's own embedded DNS
  on this machine doesn't forward back to its own dnsmasq (circular reference).

- **Fix:** Created `/etc/systemd/resolved.conf.d/rlservers.conf`:
  ```
  [Resolve]
  DNS=10.25.0.108
  Domains=~rlservers.com ~prod.local
  ```

- **Result:** systemd-resolved now routes rlservers.com directly to dnsmasq at 10.25.0.108
  instead of going through NetBird's embedded DNS which can't self-forward.

## Grafana Without OpenBao

- **Problem:** Grafana needs `grafana-admin-secret` populated by ExternalSecrets from OpenBao.
  When OpenBao (on pve-prod1) is offline, ExternalSecrets can't populate the secret.
  Grafana pod stays in `CreateContainerConfigError`.

- **Fix:** Manually create the secret:
  ```
  kubectl create secret generic grafana-admin-secret -n apps-grafana \
    --from-literal=admin-user=admin \
    --from-literal=admin-password='Unified*Presume8*Sudoku*Karate'
  ```
  When OpenBao returns, delete the secret and ExternalSecrets will repopulate it.
