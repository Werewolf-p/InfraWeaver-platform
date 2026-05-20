---
title: Init VM Script — Patterns and Gotchas
description: Key implementation decisions and gotchas in create-init-vm.sh
---

# Init VM Script — Patterns and Gotchas

## Memory

- **File:** `scripts/init/create-init-vm.sh`
- **Purpose:** Creates a lightweight Ubuntu 24.04 cloud VM on Proxmox that serves the InfraWeaver init wizard.

## CLI Parameter Support (all flags + env var equivalents)

| Flag | Env Var | Notes |
|---|---|---|
| `--vmid` | `IW_VMID` | VM ID, defaults to next available |
| `--name` | `IW_VM_NAME` | VM name, defaults to `infraweaver-init` |
| `--storage` | `IW_STORAGE` | Proxmox storage pool |
| `--bridge` | `IW_BRIDGE` | Management bridge (e.g. `vmbr0`) |
| `--vlan` | `IW_VLAN_TAG` | VLAN tag, empty string = untagged |
| `--ip` | `IW_VM_IP` | Static IP address |
| `--gw` | `IW_VM_GW` | Gateway (auto-calculated from IP+CIDR if omitted) |
| `--cidr` | `IW_VM_CIDR` | Prefix length (e.g. `24`) |
| `--no-cluster-nic` | | Skips adding a second NIC |
| `--repo` | `IW_REPO_URL` | Git repo URL |
| `--branch` | `IW_REPO_BRANCH` | Git branch |
| `--cpu` | `IW_CPU` | CPU cores (default 2) |
| `--mem` | `IW_MEM` | RAM in MB (default 1024) |
| `--disk` | `IW_DISK` | Disk size in GB (default 8) |
| `--ssh-pubkey` | `IW_SSH_PUBKEY` | SSH public key for `iw` user |
| `--yes` / `-y` | `IW_YES=1` | Skip confirmation summary prompt |
| `--help` / `-h` | | Print usage and exit |

## TTY Detection and Non-Interactive Mode

```bash
_HAS_TTY=false
{ printf '' >/dev/tty && _HAS_TTY=true; } 2>/dev/null || true
```

- `ask()`, `askyn()`, `choose()` all check `_HAS_TTY` and fall back to defaults silently
- This means the script works in `wget | bash` non-TTY contexts — all prompts default
- `--yes` flag skips ONLY the final confirmation summary prompt

## VLAN Sentinel Pattern

```bash
VLAN_TAG="${IW_VLAN_TAG-_ask_}"   # NOTE: no colon before dash!
```

- Without colon: `_ask_` only when IW_VLAN_TAG is **unset**
- Setting `IW_VLAN_TAG=` (empty) means **untagged** — no VLAN
- Setting `IW_VLAN_TAG=3` means VLAN 3
- `_ask_` triggers interactive VLAN selection

## Gateway Calculation

```bash
_calc_gw_from_ip() {
  # Called AFTER user enters IP+prefix
  # Computes network_address.1 via awk (e.g. 10.10.0.50/24 → 10.10.0.1)
}
```

- Bridge IP is on the native/untagged VLAN — irrelevant when user picks a tagged VLAN
- Gateway is always recalculated from user-entered IP+prefix, not from bridge info

## VLAN-Aware Bridge Detection

- Bridge VLAN IDs scraped via `pvesh get /nodes/{node}/network/{iface}`
- VLAN membership: VMs on each VLAN listed using `pvesh get /cluster/resources`
- Bridge display shows: `vmbr0 (10.25.0.3/24) [VLAN-aware: 2,3] [this host]`
- VLAN menu shows: `VLAN 3 [vm1,vm2,vm3]` so user knows what's on each network

## Cloud Image Cache

```bash
IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
IMAGE_CACHE="/var/lib/vz/template/iso/ubuntu-24.04-cloud.img"
```

- Image is cached on first run; subsequent runs skip the download

## Why No DHCP/Dynamic IP Detection

Dynamic IP detection via ARP/guest-agent/dnsmasq leases was removed because:
- VLAN-tagged VMs are on a different subnet from the Proxmox host — ARP misses them
- Guest agent takes 60–90s to start after VM boot
- Simpler UX: ask for static IP+CIDR, show `http://<ip>:8080` immediately

## Lesson Learned

- When `VLAN_TAG` is passed empty via env (`IW_VLAN_TAG=`), the original `${IW_VLAN_TAG:-_ask_}` (with colon) would substitute `_ask_` — empty IS a valid value (untagged). Changed to `${IW_VLAN_TAG-_ask_}` (no colon).
