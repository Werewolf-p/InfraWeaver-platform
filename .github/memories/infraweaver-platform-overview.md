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

## Cluster: productie (DEPLOYED & RUNNING)

**Nodes:** 3× Talos control-plane (10.10.0.90/91/92), VMs 9310/9311/9312 on `proxmox`
**Kubeconfig/Talosconfig:** `envs/productie/generated/kubeconfig` / `talosconfig`
**Init VM:** 10.10.0.50 (iw user, SSH via Proxmox host key), `/opt/infraweaver/`

### Key Credentials (stored in cluster secrets)
- **Vault (OpenBao):** token `s.zjpd1EJCDaqOd7O9u0jzSNMh`, port-forward svc/openbao 18200:8200
- **Authentik bootstrap token:** `oYjSgljg8IuYQPmkIUbUPot27KwyIx2puaRdLEy`
- **Authentik admin password:** `ygw8TzdNXfQkNyjIUkMmNc1t`
- **Onedev admin:** `admin` / `OyH2drGufEE7dUIKsL69daa3`

### Critical Fixes Applied (commit these facts)
1. **Cert-manager:** `prometheus.enabled: false` in values.yaml (no Prometheus Operator → no ServiceMonitor)
2. **ExternalSecrets:** All manifests must use `apiVersion: external-secrets.io/v1` (v1beta1 removed)
3. **Self-signed CA:** `.infraweaver.local` uses `infraweaver-ca` ClusterIssuer (Let's Encrypt rejects `.local` TLD)
   - `infraweaver-ca-selfsigned` → `infraweaver-ca` cert in cert-manager ns → `infraweaver-ca` ClusterIssuer
   - File: `kubernetes/core/cert-manager/manifests/ca-issuer.yaml`
4. **Authentik LDAP outpost:** Use `http://authentik-server.authentik.svc.cluster.local` (HTTP, internal)
   - `AUTHENTIK_INSECURE: "true"` also set; avoids TLS cert chain issues with self-signed CA
   - LDAP provider (PK 37) must have an Application assigned (`infraweaver-ldap-directory`) — required for `/api/v3/outposts/ldap/` to return results
   - Outpost PK: `1b1ef077-08a1-462f-b1ca-d4e5b9718ca3`
   - Outpost token stored in OpenBao: `secret/platform/authentik-ldap-outpost` key `token`
5. **Talos registry mirrors:** `onedev.infraweaver.local` → `http://onedev.infraweaver.local`
   - HTTP mirror avoids TLS Host-header mismatch (IP vs hostname)
   - Configured via `onedev_registry_hostname` in terraform/main.tf → talos-cluster module

### ArgoCD Git Sources (CRITICAL)
- **Helm values files** (cert-manager, etc.) → read from **GitHub** `https://github.com/Werewolf-p/InfraWeaver-platform`
- **Kubernetes manifests** → read from **Onedev** `http://onedev.onedev.svc.cluster.local/InfraWeaver-platform`
- Changes MUST be pushed to BOTH remotes: `git push origin main && git push onedev main`
- Onedev push: requires port-forward `kubectl port-forward -n onedev svc/onedev 19301:6610`
