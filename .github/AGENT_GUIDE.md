# InfraWeaver Platform — AI Agent Guide

> **Purpose:** This document is the primary onboarding and task reference for any AI agent
> working on this repository. Read it fully before touching any code or running any command.

---

## 1. How the Platform Works

### Overview

InfraWeaver is a self-hosted Kubernetes management platform running on **Talos Linux** VMs
inside **Proxmox VE**. It consists of three applications and a GitOps delivery layer:

| Component | Path | Role |
|---|---|---|
| `infraweaver-console` | `apps/infraweaver-console/` | Next.js UI — operator-facing dashboard |
| `infraweaver-api` | `apps/infraweaver-api/` | Hono API — the ONLY service allowed to talk to Kubernetes |
| `infraweaver-node` | `apps/infraweaver-node/` | Node agent — runs in-cluster, connects back to the API |
| `kubernetes/` | `kubernetes/` | All ArgoCD-managed manifests (source of truth for cluster state) |

### The Golden Rule: Console → API → Kubernetes

```
Browser → Console (Next.js UI) → infraweaver-api (Hono) → Kubernetes / ArgoCD / Longhorn
```

**The console must NEVER call Kubernetes directly.** It must always go through
`infraweaver-api`. This separation:
- Keeps auth, RBAC, and audit logging in one place
- Lets the API be called by other clients (CLI, mobile, automation)
- Makes the console a thin display layer

⚠️ **Known violation (TODO to fix):** Many console API routes under
`apps/infraweaver-console/src/app/api/` currently import `@kubernetes/client-node` and call
the K8s API directly. These must be migrated to call `infraweaver-api` HTTP endpoints instead.
See [Section 5 — What Is Broken](#5-what-is-broken) for the full list.

---

## 2. Git Flow and Source of Truth

### Initial Clone and Onedev Setup

The intended bootstrap sequence is:

```
1. GitHub (Werewolf-p/InfraWeaver-platform) ← public remote, CI/CD, PR workflow
        ↓ git clone (first time only)
2. Onedev (onedev.rlservers.com/InfraWeaver-platform) ← internal mirror, ArgoCD source
        ↓ all subsequent work and ArgoCD syncs happen here
3. ArgoCD polls Onedev (http://onedev.onedev.svc.cluster.local/InfraWeaver-platform)
        ↓ applies kubernetes/ manifests to the cluster
```

**Why Onedev?**
- No GitHub API rate limits for ArgoCD polling
- Local = faster sync, no external dependency
- Supports service accounts for ArgoCD access without PAT rotation
- Hosts CI runners with full cluster access

### Current State (partially implemented)

- ✅ ArgoCD pulls from `http://onedev.onedev.svc.cluster.local/InfraWeaver-platform`
- ✅ GitHub Actions CI/CD pushes builds and changes to both remotes
- ⚠️ `git-provider.ts` defaults to GitHub (`GIT_PROVIDER=github`) — should default to `onedev`
  when running in-cluster
- ⚠️ Onedev SSO via Authentik has an `invalid_client` error (OIDC client config mismatch)
- ⚠️ Onedev service account for ArgoCD is not fully automated in bootstrap

### Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production. Protected. Requires PR. |
| `feature/*` | Short-lived feature branches |
| CI deploys | Committed directly to `main` by workflows (`[skip ci]` tag) |

### Pushing Changes

Always push to **both** remotes:
```bash
git push origin main       # GitHub (CI/CD triggers here)
git push onedev main       # Onedev (ArgoCD source of truth)
```

If Onedev is ahead (force push needed due to rebase):
```bash
git push onedev main --force
```

---

## 3. Kubernetes Structure

```
kubernetes/
├── bootstrap/          ← App-of-Apps: ArgoCD Application objects for every service
│   ├── app-*.yaml      ← Platform services (authentik, traefik, netbird, etc.)
│   ├── core-*.yaml     ← Core infrastructure (metallb, cert-manager, longhorn, etc.)
│   └── catalog-*.yaml  ← Installed community apps (one file = one installed app)
│                         IMPORTANT: these files ARE installed apps. Deleting = uninstall.
├── catalog/            ← Available app definitions + deployed manifests
│   └── <slug>/
│       ├── catalog.yaml      ← Metadata (name, description, image, ingress host)
│       └── manifests/        ← K8s resources (Deployment, Service, IngressRoute, PVC)
├── core/               ← Base cluster config (limitranges, priority classes, RBAC)
├── platform/           ← Platform services managed by Helm/ArgoCD
├── apps/               ← Non-catalog application manifests
└── monitoring/         ← Prometheus, Loki, Grafana stacks
```

### How Community App Install Works

```
User clicks Install in Console
  → POST /api/community-apps/deploy
  → Commits to git:
      kubernetes/bootstrap/catalog-<slug>-manifests.yaml  ← ArgoCD Application
      kubernetes/catalog/<slug>/manifests/deployment.yaml
      kubernetes/catalog/<slug>/manifests/ingressroute.yaml
      kubernetes/catalog/<slug>/catalog.yaml
  → Annotates ArgoCD bootstrap app for immediate refresh
  → ArgoCD bootstrap app picks up new Application object (~3 min or immediate)
  → ArgoCD deploys the app's manifests from kubernetes/catalog/<slug>/manifests/
```

### How Community App Uninstall Works (Correct Flow)

```
User clicks Remove in Console
  → DELETE /api/community-apps/[slug]
  → Step 1: Remove ArgoCD finalizer from catalog-<slug>-manifests Application object
  → Step 2: Delete namespace (cascade-deletes all pods/PVCs/services)
  → Step 3: Delete the ArgoCD Application object itself
  → Step 4: Delete kubernetes/bootstrap/catalog-<slug>-manifests.yaml from git
  → Step 5: Optionally delete kubernetes/catalog/<slug>/manifests/ from git
  → Step 6: Annotate bootstrap app for hard refresh
  → ArgoCD bootstrap sees Application object gone AND file gone → stays clean
```

**Why this order matters:** If you delete the file from git BEFORE deleting the ArgoCD
Application object, ArgoCD bootstrap sees the object as "OutOfSync" (exists in cluster, not
in git) and enters a retry loop trying to prune it via its finalizer. The finalizer tries to
cascade-delete the app's namespace — if that namespace is already stuck in Terminating, the
finalizer hangs, and bootstrap keeps retrying (up to 100 times with backoff), leaving it
Degraded for up to 3 minutes.

### What "Available to Install" Means

The list of installable apps comes from the **Unraid Community Applications AppFeed**
(external URL, cached in-memory). It is NOT the `kubernetes/catalog/` or `kubernetes/bootstrap/`
directories. Removing bootstrap files = uninstalling. The install option always remains.

---

## 4. Memory and Knowledge System

### `.github/memories/` — 94 files of accumulated knowledge

Each file covers a specific operational pattern, gotcha, or decision. **Always read relevant
memories before changing a component.** Key memories for common tasks:

| File | Topic |
|---|---|
| `community-apps-appfeed.md` | How the Unraid feed, catalog, and bootstrap interact |
| `deploy-failure-patterns-2026-05.md` | Why deploys fail and how to recover |
| `argocd-false-positive-degraded.md` | Bootstrap Degraded is often just a stale op state |
| `argocd-self-healer.md` | CronJob that auto-syncs OutOfSync apps |
| `infraweaver-api-architecture.md` | API route structure and auth patterns |
| `catalog-sync-agent.md` | How the git-provider and catalog sync work |
| `console-sa-vault-path.md` | ArgoCD service account token in OpenBao |
| `authentik-oidc-sso.md` | SSO setup and OIDC integration patterns |
| `iac-best-practices.md` | Terraform/Ansible patterns for this repo |
| `stability-root-causes-2026-05.md` | Known cluster stability issues and root causes |
| `pve-prod1-oom-kill-pattern.md` | Proxmox host memory exhaustion patterns |

### `.github/skills/` — Reusable automation scripts

Check here before writing new automation. Existing scripts may already do what you need.

### Updating Memory

After any task that reveals a new gotcha, adds a pattern, or corrects prior understanding,
write or update the relevant memory file. Format:

```markdown
---
title: Short title
description: One sentence summary
---
# Title
## Memory
- **Context:** when this applies
- **Decision/Pattern:** what to do
- **Why:** what breaks without it
- **Validation:** how to confirm
```

---

## 5. What Is Broken / Technical Debt

### 🔴 Critical: Console Calls Kubernetes Directly

**Files that violate the Console → API → K8s rule:**
```
apps/infraweaver-console/src/app/api/secrets/route.ts
apps/infraweaver-console/src/app/api/platform/status/route.ts
apps/infraweaver-console/src/app/api/network/topology/route.ts
apps/infraweaver-console/src/app/api/network/policies/route.ts
apps/infraweaver-console/src/app/api/config-maps/route.ts
apps/infraweaver-console/src/app/api/community-apps/[slug]/route.ts     ← calls k8s for finalizer removal
apps/infraweaver-console/src/app/api/community-apps/deploy/route.ts     ← calls k8s to check app status
apps/infraweaver-console/src/app/api/cluster/node-pods/route.ts
apps/infraweaver-console/src/app/api/cluster/memory-heatmap/route.ts
apps/infraweaver-console/src/app/api/cluster/pod-metrics/route.ts
apps/infraweaver-console/src/app/api/cluster/cost/route.ts
apps/infraweaver-console/src/app/api/cluster/namespace-cleanup/route.ts
apps/infraweaver-console/src/app/api/cluster/rollout/route.ts
apps/infraweaver-console/src/app/api/cluster/nodes/[name]/cordon/route.ts
apps/infraweaver-console/src/app/api/cluster/nodes/route.ts
apps/infraweaver-console/src/app/api/cluster/export/route.ts
apps/infraweaver-console/src/app/api/pods/exec/route.ts
```
**Fix:** Add corresponding routes to `infraweaver-api` and have the console call those instead.

### 🔴 Critical: Orphan Proxmox VM Process (Swap Exhaustion)

**Problem:** VM 9300 (old talos-prod-cp1) is a zombie QEMU process stuck in D-state since
April 28. It holds 5.7GB of swap and 1.4GB of RAM. Cannot be killed without a host reboot.
**Fix:** Schedule Proxmox host reboot (`root@10.25.0.3`) during a maintenance window.
After reboot, delete the dummy LVM volume: `lvremove /dev/Storage/vm-9300-disk-0`

### 🟡 Important: Onedev SSO Broken

**Problem:** Onedev returns `invalid_client` when authenticating via Authentik OIDC.
The Authentik OIDC provider for Onedev has a client authentication method mismatch.
**Fix:** Check the Authentik provider config — ensure `Client authentication` matches what
Onedev expects (typically `client_secret_post`, not `client_secret_basic`).

### 🟡 Important: git-provider Defaults to GitHub

**Problem:** `GIT_PROVIDER` env var defaults to `github` even in-cluster. All git operations
(install, uninstall, config changes) go via GitHub API, adding latency and rate-limit risk.
**Fix:** Set `GIT_PROVIDER=onedev` in the console's ExternalSecret / deployment env, and
configure `ONEDEV_TOKEN`, `ONEDEV_URL`, `ONEDEV_PROJECT_ID`, `ONEDEV_PROJECT_PATH`.

### 🟡 Important: ArgoCD Bootstrap Retry on Manual Deletes

**Problem:** When apps/namespaces are manually deleted from the cluster without following
the correct uninstall order, ArgoCD bootstrap enters a retry loop (up to 100 attempts with
backoff) and shows Degraded. Bootstrap auto-recovers but takes minutes.
**Fix:** Always follow the uninstall order in Section 3. If already stuck:
```bash
kubectl patch app -n argocd bootstrap --type=json -p '[{"op":"remove","path":"/status/operationState"}]'
kubectl annotate app -n argocd bootstrap argocd.argoproj.io/refresh=hard --overwrite
```

### 🟡 Important: ArgoCD Repo Cache Lags Onedev

**Problem:** After pushing to Onedev, ArgoCD sometimes uses an old cached revision for
several minutes. Restarting `argocd-repo-server` clears the cache but the pod starts fresh.
**Fix:** Use hard refresh annotations. If still stale, restart the repo-server:
```bash
kubectl rollout restart deployment/argocd-repo-server -n argocd
kubectl annotate app -n argocd <appname> argocd.argoproj.io/refresh=hard --overwrite
```

### 🟢 Minor: Update Manager Shows Wildcard Versions

**Problem:** Update Manager shows `9.*`, `v1.*` etc. as "Current version" because it reads
`targetRevision` from the ArgoCD Application spec, which uses SemVer wildcards for Helm
charts. The actual deployed version is in `status.sync.revisions[1]` (multi-source) or
`status.sync.revision` (single-source).
**Status:** Partially fixed in commit `b52c6b22`. `deployedVersion` now reads from the
correct field. Available versions still need a Helm repo lookup implementation.

---

## 6. TODOs and Improvement Tasks

### Priority 1 — Stability and Correctness

- [ ] **Schedule Proxmox host reboot** to kill orphan VM 9300 and free 7GB swap.
      After reboot: `lvremove -f /dev/Storage/vm-9300-disk-0` (dummy volume we created)
- [ ] **Fix Onedev SSO** (`invalid_client` error). Check Authentik OIDC provider for
      Onedev — set `Client auth method: client_secret_post`.
- [ ] **Switch GIT_PROVIDER to onedev in-cluster.** Add `GIT_PROVIDER=onedev` to
      `kubernetes/catalog/infraweaver-console/manifests/` deployment env + ExternalSecret.
      This makes all git operations go through the local Onedev instance.
- [ ] **Enable memory ballooning on Talos VMs.** Currently `balloon: 0`. Need Talos
      to support virtio-balloon driver. Check Talos issue tracker. Reduces Proxmox host
      memory pressure dynamically. Alternatively: reduce TrueNAS from 8GB to 6GB after
      installing qemu-guest-agent.

### Priority 2 — Architecture Correctness

- [ ] **Migrate console routes to call infraweaver-api** (see broken list in Section 5).
      Pattern: add route to `apps/infraweaver-api/src/routes/`, call it from console via
      `fetch('/api/v1/...')` instead of importing `@kubernetes/client-node`.
      Start with: `community-apps/[slug]/route.ts` and `community-apps/deploy/route.ts`
      since those are the most impactful (install/uninstall is core functionality).
- [ ] **Community app uninstall: ensure correct deletion order** is always followed.
      The current `DELETE /api/community-apps/[slug]` route already does this correctly —
      but the console also has manual "Remove" buttons in the Apps section that may bypass it.
      Audit all removal paths.
- [ ] **Add mass-action API endpoints** to infraweaver-api:
      `POST /api/v1/apps/bulk` with `action: start|stop|remove|sync` and `apps: string[]`.
      Console Apps page should call this instead of per-app requests.

### Priority 3 — Developer Experience

- [ ] **Fix Onedev bootstrap automation.** The full setup flow should be:
      1. `git clone https://github.com/Werewolf-p/InfraWeaver-platform`
      2. Run `scripts/bootstrap.sh` (or `full-redeploy.yml` workflow) — this:
         a. Provisions Talos nodes via Terraform/Proxmox
         b. Installs ArgoCD pointing at GitHub initially
         c. Deploys Onedev from `kubernetes/catalog/onedev/`
         d. Pushes repo to Onedev (mirror)
         e. Switches ArgoCD source to Onedev
         f. Sets `GIT_PROVIDER=onedev` in console deployment
      3. All future changes go to Onedev. GitHub is kept as a backup/CI mirror.
- [ ] **Document the ArgoCD → Onedev service account setup** in a memory file.
      Currently the token is in OpenBao at `secret/platform/infraweaver-console argocd-token`.
      Onedev service account creation should be automated in the bootstrap.
- [ ] **Add a health check for the GitHub→Onedev mirror sync.** A daily workflow that
      checks both remotes are at the same commit and alerts if they diverge.
- [ ] **Fix Update Manager available versions.** The dropdown needs to query the Helm
      chart repository for available versions. Each app in `platform/` has a Helm source
      with a `repoURL`. Query `<repoURL>/index.yaml` and filter by chart name.

### Priority 4 — Operational Simplification

- [ ] **Simplify community app removal.** Today, a "remove" triggers 6 steps across git,
      ArgoCD, and K8s. Proposal: make it idempotent and order-independent by having the API:
      1. Immediately patch finalizer to `[]` (non-blocking)
      2. Delete the git file (non-blocking, fire-and-forget with retry)
      3. Delete the ArgoCD app (non-blocking)
      4. Return 202 Accepted — let ArgoCD/self-healer clean up the rest
- [ ] **Add explicit ArgoCD "uninstall" syncOption** to community apps so bootstrap prune
      uses `PrunePropagationPolicy=background` (faster) not `foreground` (can deadlock).
- [ ] **Reduce Talos node memory usage.** Current: 7.8GB / 9.3GB (81%) on cp1/cp2.
      Options: tune kubelet reserved memory, scale down non-critical platform services,
      or add a 4th worker node.
- [ ] **Automate kubeconfig endpoint rotation.** Currently hardcoded to cp1 (`10.10.0.90`).
      When cp1 reboots (rolling reboot pattern), all kubectl commands fail. Use a VIP or
      round-robin across all 3 CPs. MetalLB already provides `10.10.0.200` — check if
      kube-apiserver is accessible there, or add a separate VIP for the control plane.

---

## 7. Infrastructure Reference

### Access

| Resource | Address | Notes |
|---|---|---|
| Proxmox host | `ssh root@10.25.0.3 -i ~/.ssh/deployer_ed25519` | |
| Talos CP1 | `10.10.0.90` | Primary kubeconfig target |
| Talos CP2 | `10.10.0.91` | Fallback when CP1 down |
| Talos CP3 | `10.10.0.92` | Fallback when CP2 down |
| ArgoCD UI | `argocd.rlservers.com` (VPN) | |
| Onedev | `onedev.rlservers.com` | Internal git + CI |
| OpenBao | `openbao-0` pod in `openbao` ns | Root token in session context |

### VM Inventory (Proxmox)

| VMID | Name | RAM | Status |
|---|---|---|---|
| 9310 | talos-prod-cp1 | 13312 MB | Running |
| 9311 | talos-prod-cp2 | 13312 MB | Running |
| 9312 | talos-prod-cp3 | 13312 MB | Running |
| 103 | TrueNAS | 8192 MB | Running |
| 107 | github-runner | 8192 MB | Running |
| 9200 | netbird-router | 1024 MB | Running |
| **37218** | **orphan VM 9300** | **8192 MB (5.7GB in swap)** | **⚠️ Zombie — kill with host reboot** |

### Kubeconfig Fallback Pattern

```bash
# If kubectl fails with "connection refused", rotate to next CP:
sed -i 's|https://10.10.0.90:6443|https://10.10.0.91:6443|g' ~/.kube/config
# If CP2 also fails:
sed -i 's|https://10.10.0.91:6443|https://10.10.0.92:6443|g' ~/.kube/config
```

### Key Secrets in OpenBao

```bash
VAULT_ADDR=https://127.0.0.1:8200
VAULT_TOKEN=s.AY4PUKo42ZEJDVOhVldZjWmZ
VAULT_SKIP_VERIFY=true

# Read a secret:
kubectl exec -n openbao openbao-0 -- sh -c "
  export VAULT_ADDR=https://127.0.0.1:8200
  export VAULT_TOKEN=s.AY4PUKo42ZEJDVOhVldZjWmZ
  export VAULT_SKIP_VERIFY=true
  vault kv get secret/platform/infraweaver-console
"

# Key paths:
# secret/platform/infraweaver-console  → argocd-token, github-token, onedev-token
# secret/platform/authentik            → secret-key, postgresql-password
```

---

## 8. Common Task Runbooks

### Add a New Platform Service

1. Create manifests under `kubernetes/platform/<service-name>/` or use Helm via ArgoCD
2. Add a bootstrap Application YAML at `kubernetes/bootstrap/app-<service-name>-manifests.yaml`
3. Commit and push to both remotes
4. ArgoCD bootstrap auto-syncs within ~3 min

### Remove a Community App Cleanly (Manual)

```bash
SLUG=bazarr

# 1. Remove finalizer
kubectl patch app -n argocd catalog-${SLUG}-manifests \
  --type=json -p '[{"op":"remove","path":"/metadata/finalizers"}]'

# 2. Delete namespace
kubectl delete namespace $SLUG --wait=false

# 3. Delete ArgoCD app
kubectl delete app -n argocd catalog-${SLUG}-manifests --wait=false

# 4. Remove from git
cd /path/to/repo
git rm kubernetes/bootstrap/catalog-${SLUG}-manifests.yaml
git commit -m "chore: uninstall ${SLUG}"
git push origin main && git push onedev main

# 5. Refresh bootstrap
kubectl annotate app -n argocd bootstrap argocd.argoproj.io/refresh=hard --overwrite
```

### Fix Bootstrap Stuck in Degraded

```bash
# Clear the stale operation state
kubectl patch app -n argocd bootstrap \
  --type=json -p '[{"op":"remove","path":"/status/operationState"}]' 2>/dev/null

# Hard refresh
kubectl annotate app -n argocd bootstrap argocd.argoproj.io/refresh=hard --overwrite

# If ArgoCD repo cache is stale (still using old commit):
kubectl rollout restart deployment/argocd-repo-server -n argocd
kubectl rollout status deployment/argocd-repo-server -n argocd --timeout=120s
```

### Check Cluster Health Quickly

```bash
kubectl get nodes --no-headers
kubectl get pods -A --no-headers | awk '{print $4}' | sort | uniq -c | sort -rn
kubectl get apps -n argocd --no-headers | grep -v "Synced.*Healthy"
ssh -i ~/.ssh/deployer_ed25519 root@10.25.0.3 "free -m | grep -E 'Mem|Swap'"
```

---

## 9. Architecture Principles (Non-Negotiable)

1. **GitOps is the source of truth.** Never `kubectl apply` manifests that aren't in git.
   Exception: emergency fixes — always follow up with a git commit.

2. **Console is display-only.** It reads state and calls the API. It does NOT call K8s.

3. **API owns all cluster operations.** ArgoCD sync, namespace deletion, secret reads,
   pod exec — all go through `infraweaver-api`.

4. **Secrets live in OpenBao.** Nothing sensitive in git, environment files, or ConfigMaps.
   ESO syncs from OpenBao into K8s Secrets.

5. **Onedev is the working remote for the cluster.** GitHub is the public mirror and CI
   trigger. Once Onedev is set up, all ArgoCD operations reference the internal URL.

6. **Community apps are Git-defined.** A bootstrap YAML file = installed. No file = not installed.
   The UI reflects git state, not live K8s state.

---

_Last updated: 2026-05-19 | Maintained by AI agents working on this repo_
_If you discover a new gotcha, add it to `.github/memories/` immediately._
