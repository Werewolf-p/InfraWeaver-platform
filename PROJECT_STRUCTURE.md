# InfraWeaver Platform — Project Structure

> **For AI agents:** Read `.github/AGENT_GUIDE.md` first. This file explains what every
> folder contains. The AGENT_GUIDE explains what is broken, priorities, and how to work.

---

## Root-level files

| File | Purpose |
|---|---|
| `platform.yaml` | Single source of truth — cluster name, domain, user list, feature flags. Many scripts read this. |
| `users.yaml` | All platform users with roles, groups, and email addresses. Used by `scripts/new-user.sh` and Authentik provisioning. |
| `docker-compose.yml` | Local dev stack: console + API + mock data. Run with `docker compose up`. |
| `Makefile` | Convenience targets: `make dev`, `make lint`, `make validate`, `make deploy`. Read before running raw commands. |
| `renovate.json` | Renovate bot config — auto-creates PRs for dependency updates in `apps/` and `terraform/`. |
| `.env.example` | Template for `.env` — copy to `.env` and fill in for local development. Never commit `.env`. |
| `.sops.yaml` | SOPS encryption config — tells SOPS which GPG/AGE key to use for encrypting secrets. |
| `.tool-versions` | `asdf` / `mise` pinned tool versions (kubectl, terraform, talosctl, argocd CLI etc). |
| `.pre-commit-config.yaml` | Pre-commit hooks: gitleaks (secret scan), yamllint, shellcheck, terraform fmt. |
| `CHANGELOG.md` | Release notes. Updated manually or by CI. |

---

## `.github/`

AI agent knowledge, reusable GitHub metadata, and optional GitHub integration helpers.

### `.github/optional/`
Optional GitHub-specific assets that are not required for standard local deployments.

| Path | What it does |
|---|---|
| `optional/scripts/push-secrets-to-github.sh` | Syncs `.env` values into GitHub Secrets if you explicitly enable GitHub integration. |
| `optional/scripts/setup-runner-env.sh` | Installs `.env` on an optional GitHub runner host. |

### `.github/actions/`
Reusable composite actions kept for optional GitHub integrations.

| Action | What it does |
|---|---|
| `load-env` | Reads a runner-local `.env` file into workflow env vars. |
| `setup-kubectl` | Configures `kubectl` for optional GitHub-hosted automation. |
| `setup-platform` | Installs all tools from `.tool-versions` using `asdf`/`mise`. |

### `.github/memories/` ⭐ CRITICAL
**94+ markdown files** — the AI knowledge base. Every agent must consult this before touching any component.

Each file is named `<topic>.md` and documents a pattern, gotcha, or decision:

- `community-apps-appfeed.md` — how the community app catalog works (available ≠ installed)
- `deploy-failure-patterns-2026-05.md` — known deployment failure modes and fixes
- `argocd-false-positive-degraded.md` — when ArgoCD shows Degraded but is actually fine
- `pve-prod1-oom-kill-pattern.md` — Proxmox OOM kill patterns on the production node
- `orphan-vm-9300-swap-exhaustion.md` — zombie QEMU process eating 5.7GB swap (needs reboot)
- `authentik-oidc-sso.md` — OIDC SSO setup patterns for services
- `netbird-*.md` — NetBird VPN architecture and configuration gotchas
- `openbao-*.md` — OpenBao (Vault fork) seal/unseal and secret path patterns
- `talos-*.md` — Talos Linux cluster management patterns
- `iac-best-practices.md` — IaC conventions used in this repo

**Rule:** After discovering any new gotcha or reusable pattern, write a memory file here.

### `.github/scripts/`
Utility scripts that are GitHub-specific or used in Actions workflows.

| Script | Purpose |
|---|---|
| `create-new-users.py` | Provisions new users in Authentik + OpenBao from `users.yaml`. |
| `extract_kubeconfig.py` | Extracts kubeconfig from Talos after bootstrap for use in CI. |
| `seed-openbao-authentik.sh` | Seeds initial OIDC clients into OpenBao for Authentik SSO. |
| `netbird_cleanup_peers.sh` | Removes stale NetBird peers that no longer exist. |

### `.github/agent-hooks/`
Scripts that AI agents (GitHub Copilot CLI, Claude) should run at session start.

| Script | When to run |
|---|---|
| `init_learn.sh` | Run first — loads `.github/memories/` summaries into context. |
| `consult_catalog.sh` | Run when working on community apps — shows available vs installed apps. |

---

## `apps/`

The three custom applications that make up InfraWeaver. All are TypeScript/Node.

### `apps/infraweaver-console/`
**Next.js 14 app** — the web UI. Users interact with this.

- `src/app/(dashboard)/` — all pages. One folder per page/feature.
  - `apps/` — ArgoCD application list with start/stop/sync actions
  - `community-apps/` — install/uninstall community apps from the catalog
  - `game-hub/` — game server management UI
  - `updates/` — Update Manager: view and change Helm chart versions
  - `admin/` — RBAC, settings, user management
  - `network/` — Ingress routes, network policies, DNS
  - `storage/` — PVCs, Longhorn volumes
  - `monitoring/` — Grafana embeds, Prometheus alerts
  - `secrets/` — External secrets, cert expiry
- `src/app/api/` — Next.js API routes. **⚠ Many of these call `@kubernetes/client-node` directly — architectural violation.** They should call `infraweaver-api` instead.
- `src/lib/` — shared utilities
  - `git-provider.ts` — reads/writes files to GitHub or Onedev. Controlled by `GIT_PROVIDER` env var.
  - `rbac.ts` — RBAC helpers used throughout the UI
  - `k8s.ts` — direct k8s client (should be removed once all routes go via API)
- `src/components/` — shared React components
- `CLAUDE.md` / `AGENTS.md` — AI agent-specific instructions for the console app

### `apps/infraweaver-api/`
**Express.js REST API** — the only component that should talk to Kubernetes directly.

- `src/routes/` — API endpoints:
  - `argocd.ts` — ArgoCD application listing, sync, and version management
  - `nodes.ts` — Kubernetes node info and taints
  - `pods.ts` — Pod listing, restart, log streaming
  - `updates.ts` — Update Manager: reads git targets, compares with live ArgoCD state, fetches available Helm versions
  - `clusters.ts` — Multi-cluster registry
  - `longhorn.ts` — Longhorn volume operations
  - `prometheus.ts` — Prometheus query proxy
  - `events.ts` — Kubernetes events stream
  - `rbac-sync.ts` — Syncs RBAC roles from Authentik groups to Kubernetes
  - `health.ts` — Liveness/readiness probes
- `src/lib/` — shared utilities
  - `k8s-client.ts` — single K8s client instance used by all routes
  - `rbac.ts` — RBAC enforcement middleware
  - `bootstrap.ts` — startup checks (OpenBao, ArgoCD connectivity)
- `src/middleware/` — Express middleware (auth, logger, mode-guard, security headers)
- `src/config/version-sources.ts` — maps ArgoCD app names to their Helm chart repo URLs (used by Update Manager)

### `apps/infraweaver-node/`
**Node agent** — runs as a DaemonSet on every K8s worker. Collects node-level metrics (disk, GPU, SMART data) that Prometheus cannot reach from within a pod.

- `src/` — Express server, metric collectors, health endpoint
- Exposes `/metrics` in Prometheus format on port 9100

---

## `kubernetes/`

All GitOps manifests. ArgoCD watches this directory and reconciles the cluster to match.

**⚠ Rule:** Never apply kubectl commands directly for things tracked here. Change the YAML, push to git, ArgoCD applies it.

### `kubernetes/bootstrap/`
**App-of-Apps** — every file here is an ArgoCD `Application` object. The root ArgoCD bootstrap app watches this folder.

| File pattern | What it installs |
|---|---|
| `core-*.yaml` | Core infrastructure: MetalLB, Traefik, cert-manager, Longhorn, external-secrets, Kyverno |
| `app-*.yaml` | Platform services: Authentik, ArgoCD image updater, DNS, monitoring alerts, Grafana |
| `monitoring-*.yaml` | Monitoring stack: kube-prometheus-stack, Loki |
| `platform-*.yaml` | Platform extras: Falco, Wazuh, Velero, NetBird |
| `catalog-*.yaml` | **Community apps (installed).** Presence = installed. Deleting = uninstalling. |

**Bootstrap settings:** `selfHeal: true` + `prune: true` — ArgoCD will recreate anything in this folder and delete anything no longer in this folder. Always delete the ArgoCD Application object BEFORE deleting a bootstrap file.

### `kubernetes/catalog/`
**App definitions** — one folder per available community app. Contains the Helm values / raw manifests and metadata but does NOT mean the app is installed.

```
kubernetes/catalog/<slug>/
  manifests/          # actual K8s resources for this app
  catalog.yaml        # metadata: name, description, icon, category
```

The console reads `catalog/*/catalog.yaml` to build the "available apps" list. The community app appfeed (Unraid) provides discovery; these manifests provide the actual Helm values.

### `kubernetes/core/`
Manifests for core infrastructure components managed as ArgoCD apps.

| Folder | Component |
|---|---|
| `argocd/` | ArgoCD config: RBAC, OIDC with Authentik, self-healer CronJob |
| `cert-manager/` | ClusterIssuers (Let's Encrypt prod + staging), ACME config |
| `traefik/` | IngressClass, middleware definitions, dashboard |
| `metallb/` | IP address pools, L2Advertisement resources |
| `longhorn/` | StorageClass, recurring backup jobs, S3 backup target |
| `external-secrets/` | ClusterSecretStore pointing to OpenBao |
| `kyverno/` | Policy enforcement: require labels, block privileged containers |
| `openbao/` | OpenBao (Vault fork) Helm values and unsealer config |
| `limitranges/` | Default CPU/memory limits per namespace |
| `priority-classes/` | PriorityClass definitions (system-critical, platform, apps) |
| `etcd-maintenance/` | CronJob that runs etcd defrag + snapshot weekly |
| `metrics-server/` | Metrics server Helm values |
| `csi-driver-smb/` | SMB CSI driver for TrueNAS NFS/SMB mounts |

### `kubernetes/platform/`
Platform services that sit above core infrastructure but below user-facing apps.

| Folder | Service |
|---|---|
| `authentik/` | Identity provider — OIDC/LDAP for all SSO |
| `authentik-ldap-outpost/` | Authentik LDAP outpost for apps that need LDAP |
| `dns/` | Internal DNS overrides (ExternalDNS or CoreDNS patches) |
| `external-dns/` | ExternalDNS syncing K8s Ingress → Cloudflare |
| `falco/` | Runtime security alerts |
| `wazuh/` | SIEM — log aggregation and intrusion detection |
| `grafana/` | Grafana instance (separate from kube-prometheus-stack) |
| `netbird/` | NetBird VPN management server |
| `velero/` | Cluster backup and restore |
| `minio-velero/` | MinIO instance used as Velero's S3 backend |
| `argocd-image-updater/` | Auto-bumps Docker image tags in git when new builds are pushed |
| `external-routes/` | Traefik IngressRoutes for services running outside the cluster |

### `kubernetes/monitoring/`
Everything related to observability.

| Folder | Content |
|---|---|
| `kube-prometheus-stack/` | Prometheus, Alertmanager, Grafana (bundled), node-exporter — Helm values |
| `loki/` | Log aggregation — Helm values |
| `alertmanager-discord/` | Alertmanager webhook receiver that posts to Discord |
| `alerts/` | Custom PrometheusRule resources (CPU, memory, pod crash alerts) |
| `grafana-dashboards/` | Custom Grafana dashboard ConfigMaps |

### `kubernetes/apps/`
Templates and examples for deploying custom applications via the catalog.

| Folder | Content |
|---|---|
| `_template/` | Scaffold for new catalog apps (copy this) |
| `example-app/` | Working example of a minimal app deployment |

### `kubernetes/crds/`
Custom Resource Definitions not managed by a Helm chart.

- `gameserver-crd.yaml` — GameServer CRD for the game-hub feature.

### `kubernetes/development/`
Dev/test deployments that run in the cluster but are not production.

- `infraweaver-dev/` — Dev instance of console + API with mock data for testing UI changes.

---

## `terraform/`

OpenTofu (Terraform-compatible) infrastructure-as-code for provisioning the Proxmox VMs and bootstrapping the cluster.

**State:** Stored remotely (see `envs/<env>/backend.hcl` for backend config). Never edit `.terraform/`, `terraform.tfstate`, or `.terraform.lock.hcl` directly.

| File / Folder | Purpose |
|---|---|
| `main.tf` | Root module — calls sub-modules, wires outputs to inputs |
| `variables.tf` | All input variable definitions |
| `providers.tf` | Provider declarations and version pins |
| `outputs.tf` | Exported values (IP addresses, VM IDs) consumed by Ansible/scripts |
| `backend.tf` | Remote state backend config (overridden per-env via `-backend-config`) |
| `modules/talos-cluster/` | Creates all Talos control-plane and worker VMs on Proxmox |
| `modules/cloud-init-template/` | Builds the Proxmox VM template used by talos-cluster |
| `modules/github-runner/` | Provisions an optional self-hosted GitHub Actions runner VM |
| `modules/netbird-router/` | Provisions the NetBird router VM (Proxmox LXC or VM) |
| `modules/openbao/` | Provisions the OpenBao VM (runs outside the cluster for HA) |
| `modules/platform-bootstrap/` | Post-VM provisioning: runs scripts to seed secrets and bootstrap ArgoCD |

---

## `envs/`

Per-environment configuration overrides. Each environment has its own Terraform vars, backend config, and generated files.

### `envs/productie/` — Production cluster
| File | Purpose |
|---|---|
| `terraform.tfvars` | VM sizes, IP addresses, storage pools, Proxmox node names for production |
| `services.auto.tfvars` | Service-specific toggles (which optional modules to enable) |
| `backend.hcl` | Remote state backend config (S3/MinIO endpoint + bucket + key) |
| `cluster.yaml` | Talos machine config patch for the production cluster |
| `generated/` | Auto-generated Talos configs — committed after `talosctl gen config`, never hand-edited |

### `envs/ontwikkel/` — Development/staging cluster
Same structure as `productie` but with smaller VMs and separate IPs.

---

## `ansible/`

Ansible playbooks for tasks that Terraform can't do (OS-level config, software install on non-K8s VMs).

| File | Purpose |
|---|---|
| `playbooks/configure-nodes.yml` | Post-Talos node hardening: NTP, sysctl, kernel modules |
| `playbooks/configure-proxmox-oidc.yml` | Configures Proxmox to use Authentik as OIDC login provider |
| `playbooks/github-runner.yml` | Provisions the optional GitHub Actions runner VM with required tools |
| `playbooks/openbao.yml` | Installs and initialises OpenBao on its dedicated VM |
| `Dockerfile` | Docker image with Ansible + all required collections for CI |

Inventory is generated dynamically from Terraform outputs — no static `hosts` file.

---

## `scripts/`

Shell and Python scripts for operational tasks. Grouped into:

### `scripts/deploy/` — Bootstrap and deploy scripts
Run in order during a fresh cluster deploy. Called by `scripts/deploy-local.sh` and the init website.

| Script | What it does |
|---|---|
| `install-tools.sh` | Installs kubectl, talosctl, argocd, helm onto the local init host |
| `deploy-argocd.sh` | Applies the ArgoCD bootstrap manifests to the new cluster |
| `bootstrap-openbao.sh` | Initialises OpenBao, saves unseal keys to a secure location |
| `bootstrap-externalsecrets.sh` | Configures the ExternalSecrets ClusterSecretStore to point to OpenBao |
| `configure-authentik.sh` | Seeds OIDC clients, groups, and initial admin user into Authentik |
| `configure-oidc.sh` | Configures OIDC providers for ArgoCD, Grafana, Longhorn etc |
| `seed-user-secrets.sh` | Writes per-user credentials into OpenBao |
| `ensure-cloudflare-dns.sh` | Upserts Cloudflare DNS records for all public-facing services |
| `smoke-test-url.sh` | Hits a URL and fails if it doesn't return 200 — used post-deploy |
| `check-argocd-health.sh` | Waits for all ArgoCD apps to reach Healthy/Synced or times out |
| `sync-argocd-app.sh` | Forces a hard refresh + sync for a specific ArgoCD app |
| `notify-discord.sh` | Posts a deploy status message to the Discord webhook |
| `populate-netbird.sh` | Creates NetBird setup keys and peers for all VMs |
| `generate-recovery-links.sh` | Generates time-limited recovery links for each user |
| `send-welcome-emails.sh` | Sends welcome emails with credentials to new users |
| `refresh-tls-backup.sh` | Backs up all TLS certs to TrueNAS via SMB |

### `scripts/` — Root-level operational scripts

| Script | What it does |
|---|---|
| `bootstrap-local.sh` | Full local bootstrap: provisions VMs, deploys cluster, seeds secrets |
| `new-app.sh` | Scaffolds a new community app entry (creates catalog dir + bootstrap YAML) |
| `new-user.sh` | Adds a new user to `users.yaml` and provisions them in Authentik + OpenBao |
| `health-check.sh` | Quick cluster health summary: nodes, pods, ArgoCD app status |
| `validate-cluster.sh` | Full validation: nodes Ready, all ArgoCD apps Synced+Healthy, cert expiry |
| `scaffold-page.mjs` | Scaffolds a new console page (creates route folder with boilerplate) |
| `sync-catalog.sh` | Syncs catalog metadata from the Unraid community appfeed into `kubernetes/catalog/` |
| `sync-groups.sh` | Syncs Authentik groups to match `users.yaml` role assignments |
| `seed-catalog-secrets.sh` | Seeds per-app secrets into OpenBao from a template |
| `etcd-heal.py` | Automated etcd defrag + alarm clear + snapshot |
| `restore-from-truenas.sh` | Restores PVC data from TrueNAS NFS backup |
| `generate-gatus-config.py` | Generates Gatus uptime monitor config from `platform.yaml` |
| `generate-homepage-config.py` | Generates Homepage dashboard config from `platform.yaml` |
| `validate-eso-refs.sh` | Checks all ExternalSecret refs point to existing OpenBao paths |
| `validate-platform-yaml.sh` | Validates `platform.yaml` schema |
| `validate-users-yaml.sh` | Validates `users.yaml` schema |
| `get-kubeconfig.sh` | Fetches kubeconfig from Talos and saves to `~/.kube/config` |
| `deploy-local.sh` | Full local deployment entrypoint used by the init website and terminal setup |
| `dev-start.sh` | Starts local dev environment (docker compose + file watchers) |
| `lib.sh` | Shared bash functions: `log_info`, `log_error`, `run_with_retry`, etc. Source this first. |

---

## `docs/`

Human-readable documentation (non-AI).

| File | Content |
|---|---|
| `ARCHITECTURE.md` | High-level system architecture diagram and component descriptions |
| `CATALOG.md` | How the community app catalog works (app definitions, install flow) |
| `MIDDLEWARES.md` | All Traefik middleware definitions: auth, rate-limit, headers, redirects |
| `RUNBOOK.md` | Operator runbook: common tasks, incident response, escalation paths |
| `TROUBLESHOOTING.md` | Known issues and their fixes (kept in sync with `.github/memories/`) |
| `templates/app/` | Documentation templates for new apps |

---

## `dev/`

Local development mock data. Used by `docker-compose.yml` to simulate API responses without a live cluster.

- `dev/mock/api/` — JSON files that the mock API server serves
- `dev/mock/health.json` — Mock health endpoint response
- `dev/mock/index.json` — Mock service list

---

## `images/`

Platform brand assets: logo, banner, favicon. Used by the console and README.

---

## Key architectural rules

1. **Console → API → Kubernetes.** The console must never call `@kubernetes/client-node` directly. All K8s operations go through `infraweaver-api`. (~18 console routes currently violate this — see todos.)

2. **Git is the source of truth for what is installed.** Adding a file to `kubernetes/bootstrap/` installs it. Removing a file uninstalls it. ArgoCD enforces this via `prune: true`.

3. **Correct community app uninstall order** (or bootstrap deadlocks):
   1. Patch ArgoCD app finalizer to `[]`
   2. Delete the namespace
   3. Delete the ArgoCD Application object
   4. Delete the bootstrap YAML from git
   5. Push to git and let ArgoCD reconcile

4. **Secrets never in git.** OpenBao (Vault) holds all secrets. ExternalSecret resources pull them into K8s at deploy time. `.sops.yaml` encrypts any secrets that must live in git.

5. **ArgoCD pulls from Onedev (in-cluster), not GitHub.** After bootstrap, ArgoCD's `repoURL` should point to `onedev.example.com`. The console's `GIT_PROVIDER` env var should be `onedev`. GitHub is the source for initial clone only.

6. **Memory-first development.** Before touching any component, read the relevant `.github/memories/` files. After discovering anything new, write a memory file immediately.
