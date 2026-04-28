InfraWeaver-platform — Catalog (automatically generated)

Overview

InfraWeaver-platform is the Talos + Kubernetes control plane and application catalog for the homelab. It manages the Talos clusters, ArgoCD application manifests, core platform services (Traefik, MetalLB, cert-manager, ExternalSecrets, Longhorn, monitoring stack), and the NetBird external management integration.

Top-level layout (important paths)
- platform/README.md — high-level platform overview and usage
- platform/terraform/ — OpenTofu/Terraform entry and modules for Talos cluster bootstrapping and platform bootstrap
- platform/kubernetes/ — ArgoCD application manifests and Helm values for apps
  - core/ — Traefik, cert-manager, argocd, metallb, external-secrets, longhorn
  - apps/ — netbird, grafana, loki, example-app, test-website
  - bootstrap/ — ArgoCD ApplicationSet and initial apps
- platform/.github/ — automation, agent hooks, scripts, memories
  - platform/.github/scripts/sync_netbird_status.py — sanitizer writing sanitized runtime memory
  - platform/.github/memories/ — human-readable canonical memories and runbooks
  - platform/.github/systemd/ — systemd unit examples for sync
- platform/.sops.yaml & envs/*/secrets.sops.yaml — encrypted secrets (SOPS)

Terraform and bootstrapping
- Entrypoints: platform/terraform/main.tf and envs/*/terraform.tfvars
- Modules:
  - talos-cluster — creates Talos clusters (control plane and workers)
  - platform-bootstrap — create initial resources used by ArgoCD and bootstrapping
- Backend & locking configured in platform/terraform/backend.tf
- Local .terraform and provider binaries are present — do not commit state

Kubernetes apps and roles
- ArgoCD manages apps in platform/kubernetes/* . Each YAML pairs a values.yaml (Helm) and an application manifest.
- Key apps:
  - core/argocd — ArgoCD operator + values to control sync/diff handling
  - core/traefik — Ingress controller; includes middleware for host rewriting and IP whitelists (middleware-netbird.yaml)
  - netbird — client DaemonSet, management manifests, relay and signal components; client-daemonset uses secret netbird-secrets (SETUP_KEY)
  - monitoring stack — kube-prometheus-stack (Prometheus+Grafana), Loki, and exporters
  - external-secrets — configured to fetch secrets (pattern present; currently SOPS used for envs)

Secrets management
- Primary pattern: SOPS encrypted secrets under platform/envs/*/secrets.sops.yaml; .sops.yaml at repo root configures keys
- Runtime sensitive tokens (NetBird API PAT, setup keys, rotated tokens) are intentionally NOT committed. Authoritative runtime file: /home/runner/.netbird_status.json (gitignored). sync_netbird_status.py sanitizes and updates a memory file platform/.github/memories/netbird-external-vm-setup.md
- GitHub Actions workflows that need secrets rely on SOPS or environment-specific secrets; workflows are in platform/.github/workflows

Runtime hooks and agent integration
- homelab-iac-agent and platform agent-hooks (platform/.github/agent-hooks) expect to read /home/runner/.netbird_status.json on startup and call sync script to update memory
- systemd timer examples provided in platform/.github/systemd to run sync periodically

Operational notes & gotchas (from memories)
- NetBird setup-key rotation: rotate in NetBird API, update Kubernetes secret netbird/netbird-secrets (SETUP_KEY) and rollout restart DaemonSet before revoking old key. A recorded attempt exists at platform/.github/memories/netbird-setup-key-rotation.md
- K8s DaemonSet client churn creates new peers per pod restart. Routes may need updating to point to new peer IDs via NetBird API (see memory netbird-external-vm-setup.md)
- Traefik host header rewrite middleware required for some services; check middleware-netbird.yaml
- Etcd/Talos recovery runbooks and snapshots are in platform/.github/memories (etcd-raft-corruption-recovery.md, talos-etcd-recovery.md)

Dependency map (high-level)
- Talos cluster (Terraform modules) → Kubernetes cluster control plane → ArgoCD (manages apps) → Core apps (Traefik, MetalLB, cert-manager)
- NetBird management VM (external) ↔ Traefik (routes netbird.rlservers.com) and K8s NetBird DaemonSet (clients)
- Monitoring depends on kube-prometheus-stack (Prometheus) and Loki; ArgoCD apps must be healthy for accurate alerting

Where to look first for common tasks
- Rotate NetBird setup key safely: platform/.github/memories/netbird-setup-key-rotation.md, /home/runner/.netbird_status.json (local), platform/kubernetes/apps/netbird/manifests/client-daemonset.yaml
- Bootstrapping or re-provision Talos cluster: platform/terraform and platform/terraform/modules/talos-cluster
- Fix ArgoCD sync diffs: platform/kubernetes/core/argocd/values.yaml and the ArgoCD app manifests

Next suggested actions (for automation)
1. Add a CI job to validate that platform/.github/memories/*.md are updated by sync script on changes to runtime file (catalog-validate.yml exists as a starting point)
2. Move NetBird secrets into ExternalSecrets backed by Vault or sealed secrets; reduce local runtime secret surface
3. Harden kubeconfig usage in automation (avoid --insecure-skip-tls-verify) and document required credentials for operator tasks

---
Catalog generated at: platform/.github/InfraWeaver-platform-catalog.md
