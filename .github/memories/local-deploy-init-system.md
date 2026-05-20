---
title: Local Deploy Init VM System — 2026-05
description: Complete local deployment system with Proxmox init VM, web UI, and scripts replacing GitHub Actions
---

# Local Deploy Init VM System

## Memory

- **File paths:**
  - `scripts/init/create-init-vm.sh` — runs ON Proxmox, creates lightweight Ubuntu init VM
  - `scripts/init/server.py` — Python web server serving the config UI + deploy progress
  - `scripts/init/templates/` — web UI (HTML/CSS/JS)
  - `scripts/deploy-local.sh` — full local deployment (reads .env, no GitHub Actions needed)
  - `scripts/redeploy-local.sh` — full redeploy (destroys cluster, keeps .env + users.yaml)

- **Decision:** Add a complete "zero GitHub Actions" local deployment path. A user can:
  1. Run `create-init-vm.sh` on any Proxmox host → creates lightweight init VM
  2. Access the init VM's web UI at `http://<vm-ip>:8080` to fill .env
  3. Click "Deploy" → cluster is provisioned and bootstrapped locally
  OR just: `cp .env.example .env && nano .env && bash scripts/deploy-local.sh`

- **Init VM Spec:** Ubuntu 24.04 cloud image, VMID 9001, 1 CPU, 1GB RAM, 8GB disk on lvm-proxmox
  - Auto-starts init server on port 8080 via systemd on first boot
  - Clones repo, installs tools, serves web UI

- **Key differences from GitHub Actions flow:**
  - GitHub Secrets → `.env` file (or environment variables)
  - SOPS not required for local deploy — secrets read directly from .env
  - State stored at `~/.tofu/state/platform-productie/`
  - SSH key written from DEPLOYER_SSH_KEY env var to `~/.ssh/deployer_ed25519`
  - Kubeconfig at `~/.kube/config-platform-productie`
  - AGE_SECRET_KEY optional for local deploy (SOPS only needed for secrets.sops.yaml which local deploy bypasses)

- **Why it matters:** Enables self-contained deployment without GitHub dependency. Critical for:
  - Fresh homelab setups with no GitHub runner
  - Air-gapped or local-only environments
  - Bootstrapping before GitHub Actions runner is deployed

- **Validation:** Tested with full cluster destroy + redeploy on 2026-05-19. All 3 talos VMs provisioned, cluster bootstrapped, ArgoCD deployed, all services synced.

- **PLATFORM_VMIDS:** `9300 9301 9302 9310 9311 9312` — do NOT include 9100 (runner) or 9200 (netbird-router)
