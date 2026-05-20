---
title: InfraWeaver Platform — Architecture Overview
description: Core facts about the InfraWeaver platform repository, startup paths, and key file locations.
---

# InfraWeaver Platform — Architecture Overview

## Memory

- **What it is:** GitOps-driven Kubernetes (Talos) platform self-deploys on Proxmox VE via a single `wget | bash` command.
- **Repo:** `https://github.com/Werewolf-p/InfraWeaver-platform` (main branch is canonical)
- **Proxmox host:** `10.25.0.3`, root / `zbxQSR&eRma7dbdT9kMnGttNrRNR7BC#d6cG3*@Ku4D7CU7Zhhkt1eFCeX3Y`
- **SSH:** `ssh root@10.25.0.3` works from this machine (Proxmox host has a private key for itself)

## Three Startup Paths

1. **Proxmox VM:** `wget -qO- .../scripts/init/create-init-vm.sh | bash` (on Proxmox host)
2. **Any Linux/Mac:** `wget -qO- .../scripts/init/start-local.sh | bash`
3. **Cloned repo:** `python3 scripts/init/server.py`

## Key File Locations

| File | Purpose |
|---|---|
| `scripts/init/create-init-vm.sh` | Proxmox bootstrap — creates Ubuntu init VM |
| `scripts/init/start-local.sh` | Local startup without Proxmox |
| `scripts/init/server.py` | Python HTTP server — serves init wizard UI + API |
| `scripts/init/out/index.html` | **Actual served UI** — compiled Next.js static export |
| `apps/infraweaver-init/` | Next.js wizard source (`npm run build` → `out/`) |
| `scripts/deploy-local.sh` | Full deployment pipeline (18 stages, emits `STAGE:*` markers) |
| `scripts/generate-from-env.sh` | Substitutes `${PLACEHOLDERS}` in kubernetes/ YAML files |
| `envs/productie/cluster.yaml` | Template substituted by generate-from-env.sh |
| `apps/infraweaver-console/` | Management console (Next.js, deployed as K8s app) |

## Critical: Served UI is `scripts/init/out/index.html`

`server.py` serves `out/index.html` FIRST. `templates/index.html` is dead code while `out/` exists.

After ANY UI change:
```bash
cd apps/infraweaver-init && npm run build
cp -r out/* ../../scripts/init/out/
git add scripts/init/out/ && git commit && git push
```

## Wizard Store Architecture (store.ts persist v4)

- `WizardData` = flat env-serializable fields → serialised to `.env` via `getEnvPayload()`
- `nodes: NodeConfig[]` lives at WizardStore root (NOT inside WizardData)
- `getEnvPayload()` serialises `nodes[]` → `NODE_N_*` env vars
- `loadFromEnv()` parses `NODE_N_*` → `nodes[]`
- `NODE_COUNT` env var controls `generate-from-env.sh` loop (was hardcoded range(1,4))

## Deployment

- OpenTofu manages Talos VMs on Proxmox via `terraform/`
- ArgoCD syncs all apps from the Onedev git repo (self-hosted, deployed as part of bootstrap)
- Onedev runs at `http://onedev.onedev.svc.cluster.local/InfraWeaver-platform`
