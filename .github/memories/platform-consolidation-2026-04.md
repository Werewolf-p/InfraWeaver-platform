---
title: Platform Architecture — All-in-one on Proxmox 10.25.0.3
description: All VMs and K8s run on single Proxmox node 10.25.0.3; VLAN3 for K8s, VLAN1 for management.
---

# Platform Architecture — April 2026

## Current State

Everything runs on a single Proxmox node (`proxmox`, `10.25.0.3`).

### VMs

| VM ID | Name | IP | Purpose |
|-------|------|----|---------|
| 9000 | ubuntu-cloud-init | template | Ubuntu 24.04 cloud-init base template |
| 9100 | github-runner | 10.25.0.85 | GitHub Actions self-hosted runner |
| 9200 | openbao | 10.25.0.86 | OpenBao (Vault) secrets engine |
| 9250 | netbird-router-vlan3 | 10.10.0.10 | NetBird VPN routing peer (VLAN3) |
| 9300 | talos-prod-cp1 | 10.10.0.90 | Talos K8s control plane 1 |
| 9301 | talos-prod-cp2 | 10.10.0.91 | Talos K8s control plane 2 |
| 9302 | talos-prod-cp3 | 10.10.0.92 | Talos K8s control plane 3 |

### Networks

- **VLAN1 (10.25.0.0/24):** Proxmox management, OpenBao, GitHub Runner
- **VLAN3 (10.10.0.0/24):** Talos K8s cluster, MetalLB VIPs, NetBird router peer

## Terraform Modules (in `terraform/modules/`)

- `talos-cluster/` — Talos VMs + cluster bootstrap + kubeconfig output
- `platform-bootstrap/` — ArgoCD install + App-of-Apps ApplicationSet
- `cloud-init-template/` — Ubuntu 24.04 template creation on Proxmox
- `github-runner/` — GitHub Actions runner VM
- `openbao/` — OpenBao VM (Vault-compatible)
- `netbird-router/` — NetBird routing peer VM on VLAN3

## Key Decisions

- **Single Proxmox node:** Removed intermediate pve-prod1/2/3 nested cluster (too much overhead)
- **Talos stacked HA:** 3x CP nodes, no dedicated workers (CP nodes also run workloads)
- **OpenBao on VLAN1:** Accessible from K8s via cluster ExternalSecret store + from runner
- **NetBird router on VLAN3:** Needed to be on the same VLAN as K8s MetalLB VIPs to advertise them
- **No hardcoded secrets:** All secrets randomly generated at deploy time, stored in OpenBao
- **GitHub Runner as the hub:** Runner has Proxmox API access, OpenBao access, K8s kubeconfig

## Secrets Model

1. GitHub Secrets hold only **deployment-time infrastructure credentials**:
   - `PROXMOX_API_TOKEN` — Terraform Proxmox access
   - `CLOUDFLARE_API_TOKEN` — cert-manager DNS-01 challenges + Cloudflare config
   - `SMTP_USERNAME` / `SMTP_PASSWORD` — deployment notification emails
   - `NETBIRD_PAT_TOKEN` — NetBird API for setup key creation

2. OpenBao holds **all application runtime secrets**:
   - `secret/platform/authentik` — bootstrap-password, secret-key, postgresql-password, etc.
   - `secret/platform/netbird` — relay-secret, setup-key, datastore-key
   - `secret/platform/argocd` — admin-password
   - `secret/platform/grafana` — admin-password
   - `secret/platform/cloudflare` — CF_API_TOKEN (for cert-manager in cluster)
   - etc.

3. ExternalSecret CRDs sync from OpenBao to K8s Secrets at runtime

## Deployment Flow

```
GitHub Actions (full-redeploy.yml)
  1. Cleanup NetBird peers for old cluster
  2. terraform destroy → recreates all VMs
  3. Wait for Talos bootstrap → get kubeconfig
  4. Fix CoreDNS race condition (wait for OpenBao to be ready)
  5. Deploy ArgoCD + App-of-Apps
  6. Bootstrap local-path-provisioner storage
  7. Unseal OpenBao + configure ExternalSecrets
  8. Apply MetalLB + Traefik middleware
  9. Patch CoreDNS for internal DNS zones
  10. Set Authentik admin user (remon → authentik Admins group)
  11. Send deployment summary email
```

## Post-Deploy Known Steps

- Check for etcd CORRUPT alarm: `kubectl exec -n kube-system etcd-... -- etcdctl alarm list`
  If CORRUPT: run etcd-fix.yml workflow to recover
- NetBird router peer re-enrolls automatically via setup key (from Terraform outputs)

## File Paths

- `terraform/main.tf` — Top-level module composition
- `terraform/envs/productie/services.auto.tfvars` — All configurable values
- `kubernetes/bootstrap/` — ArgoCD App-of-Apps root
- `.github/workflows/full-redeploy.yml` — Full redeploy pipeline (1017 lines)
