# InfraWeaver Deployment Model

## How It Works

InfraWeaver deploys **entirely locally** on your Proxmox homelab.
GitHub is only used as the source to clone this template — after that, everything runs locally.

## Flow

1. **Clone** this repo to your Proxmox init VM
2. **Configure** via the init website (`bash scripts/init/start.sh`)
3. **Deploy** — the init website triggers `scripts/deploy-local.sh` which:
   - Provisions VMs on Proxmox via OpenTofu
   - Bootstraps the Talos Kubernetes cluster
   - Installs ArgoCD and the full application platform
4. **Manage** — ongoing operations via:
   - InfraWeaver Console at `https://console.${BASE_DOMAIN}`
   - Local Onedev git server at `https://onedev.${BASE_DOMAIN}` (your private GitHub)
   - Local ArgoCD at `https://argocd.int.${BASE_DOMAIN}`

## GitHub Actions

This repository does NOT use GitHub Actions for deployments.
All CI/CD runs on your local Onedev instance after initial setup.
