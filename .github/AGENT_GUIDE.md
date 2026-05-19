# InfraWeaver Platform — AI Agent Guide

> **You are an AI agent. This file is your complete briefing.**
> Read every section before touching any code, running any command, or making any decision.
> Everything you need is here: credentials, test commands, what is broken, what to build next.

---

## ⚡ Core Philosophy — This Is Your Prime Directive

> **Simplify. Generalise. Remove code, don't add it.**

Every change you make must leave the codebase **smaller and easier to understand** than before.

- **Delete before adding** — is there existing code that already does this?
- **Remove duplication** — two similar routes should become one generic route
- **Generalise** — `GET /api/v1/resources?type=pods` beats five separate pod/node/service routes
- **Flatten abstractions** — remove layers that exist only to call one other layer
- **Kill dead code** — unused pages, routes, helpers, and types should be deleted
- **No over-engineering** — no error handling for errors that can't happen in practice
- **Self-documenting code** — don't comment what the code already says

This platform must be understandable to a single developer in one sitting.
When in doubt: make it smaller, make it simpler, make it work.

---

## 1. Platform Architecture

### Three Apps, One Rule

```
Browser  →  infraweaver-console (Next.js)  →  infraweaver-api (Hono)  →  Kubernetes
```

| App | Path | Role |
|---|---|---|
| `infraweaver-console` | `apps/infraweaver-console/` | Web UI. Display only. Calls the API. |
| `infraweaver-api` | `apps/infraweaver-api/` | The ONLY app that talks to Kubernetes |
| `infraweaver-node` | `apps/infraweaver-node/` | DaemonSet. Node metrics → API |

**The console must NEVER import `@kubernetes/client-node` or call Kubernetes directly.**
⚠️ This rule is currently violated in ~18 console API routes — see Section 5.

### Git → ArgoCD → Cluster

```
GitHub (Werewolf-p/InfraWeaver-platform)    ← public remote, CI/CD triggers
      ↓ mirror after bootstrap
Onedev (onedev.rlservers.com/InfraWeaver-platform)  ← ArgoCD source, no rate limits
      ↓ polls every 3 min
ArgoCD  →  applies kubernetes/ to the cluster
```

- After any change, push to **both** remotes:
  ```bash
  git push origin main && git push onedev main
  ```
- If a force push is needed: `git push onedev main --force`

---

## 2. Credentials and Access

### Kubernetes

```bash
# kubeconfig is already at ~/.kube/config (context: admin@infraweaver-prod)
kubectl get nodes

# If connection refused, CP1 is rebooting — rotate to next:
sed -i 's|10.10.0.90:6443|10.10.0.91:6443|g' ~/.kube/config
# Back to CP1: sed -i 's|10.10.0.91:6443|10.10.0.90:6443|g' ~/.kube/config

# Control plane IPs:  CP1=10.10.0.90  CP2=10.10.0.91  CP3=10.10.0.92
```

### ArgoCD

```bash
# CLI login (already installed on runner)
argocd login argocd.int.rlservers.com --username admin --password GS8Su3jXVNDODVb8 --insecure

# Or via port-forward:
kubectl port-forward -n argocd svc/argocd-server 8080:80 &
argocd login localhost:8080 --username admin --password GS8Su3jXVNDODVb8 --insecure

# Useful ArgoCD commands:
argocd app list
argocd app sync <appname> --force
argocd app get bootstrap
```

### Onedev (Internal Git)

```
URL:      https://onedev.rlservers.com
User:     admin
Password: xAYtN6OEtKFkm788zY4u6OvaY6vlph
API base: https://onedev.rlservers.com/~api/

# Git remote already configured:
# onedev https://admin:xAYtN6OEtKFkm788zY4u6OvaY6vlph@onedev.rlservers.com/InfraWeaver-platform

# Onedev REST API examples:
curl -u admin:xAYtN6OEtKFkm788zY4u6OvaY6vlph \
  https://onedev.rlservers.com/~api/projects/InfraWeaver-platform

# Create a service account token for ArgoCD:
curl -X POST -u admin:xAYtN6OEtKFkm788zY4u6OvaY6vlph \
  https://onedev.rlservers.com/~api/users/argocd/access-tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"argocd-token","expireAfterDays":0}'
```

### Proxmox Host

```bash
ssh -i ~/.ssh/deployer_ed25519 root@10.25.0.3

# Useful Proxmox commands:
qm list                                     # list VMs
free -m                                     # host memory
swapon --show                               # swap usage
grep VmSwap /proc/37218/status              # orphan VM 9300 swap (PID 37218)
```

### OpenBao (Vault)

```bash
# Read secrets:
kubectl exec -n openbao openbao-0 -- sh -c "
  VAULT_ADDR=https://127.0.0.1:8200
  VAULT_SKIP_VERIFY=true
  VAULT_TOKEN=s.AY4PUKo42ZEJDVOhVldZjWmZ
  vault kv get secret/platform/infraweaver-console
"

# Key paths:
# secret/platform/infraweaver-console  → argocd-token, github-token, onedev-token
# secret/platform/authentik            → secret-key, postgresql-password
# secret/infraweaver/console-sa        → SA token for console K8s access
```

### InfraWeaver API (Runner → Cluster)

```bash
# Token is already saved at:
cat /home/runner/.iw_token       # 500-byte JWE token

# Call the API (internal, via port-forward):
kubectl port-forward -n infraweaver-console svc/infraweaver-api 3001:3001 &
curl http://localhost:3001/health
curl -H "Authorization: Bearer $(cat ~/.iw_token)" http://localhost:3001/api/v1/pods

# Public URL (VPN required):
curl https://api.int.rlservers.com/health
```

---

## 3. Testing — How to Verify Your Changes

### Port-Forward All Services Locally

```bash
# Console UI (http://localhost:3000)
kubectl port-forward -n infraweaver-console svc/infraweaver-console 3000:3000 &

# InfraWeaver API (http://localhost:3001)
kubectl port-forward -n infraweaver-console svc/infraweaver-api 3001:3001 &

# ArgoCD UI (http://localhost:8080)
kubectl port-forward -n argocd svc/argocd-server 8080:80 &

# Onedev (http://localhost:8081)
kubectl port-forward -n onedev svc/onedev 8081:80 &

# Longhorn (http://localhost:8082)
kubectl port-forward -n longhorn-system svc/longhorn-frontend 8082:80 &
```

### Testing with the Service Account Token

The console service account (`infraweaver-console-sa`) has cluster-read + limited-write RBAC.
Use this token to test API calls as the console would make them:

```bash
# Get the SA token:
SA_TOKEN=$(kubectl get secret infraweaver-console-sa-token -n infraweaver-console \
  -o jsonpath='{.data.token}' | base64 -d)

# Or from OpenBao:
SA_TOKEN=$(kubectl exec -n openbao openbao-0 -- sh -c "
  VAULT_ADDR=https://127.0.0.1:8200 VAULT_SKIP_VERIFY=true
  VAULT_TOKEN=s.AY4PUKo42ZEJDVOhVldZjWmZ
  vault kv get -field=token secret/infraweaver/console-sa
")

# Test K8s API directly with SA:
kubectl --token="$SA_TOKEN" --server=https://10.10.0.90:6443 \
  --insecure-skip-tls-verify get pods -n infraweaver-console

# Test the InfraWeaver API with the runner token:
TOKEN=$(cat ~/.iw_token)
kubectl port-forward -n infraweaver-console svc/infraweaver-api 3001:3001 &
sleep 2
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/pods | jq '.total'
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/nodes | jq '.[].name'
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/updates | jq '.[].name'
```

### Testing the Console

The console uses NextAuth with Authentik OIDC. For automated tests, get a session token:

```bash
# The console accepts direct SA token for testing (set NEXTAUTH_SECRET to sign a test session):
# Or use the existing self-test endpoint:
kubectl port-forward -n infraweaver-console svc/infraweaver-console 3000:3000 &
curl -s http://localhost:3000/api/health | jq .   # unauthenticated health
```

### Validating a Git Change Hit ArgoCD

```bash
# After git push, check ArgoCD saw the new commit:
argocd app get bootstrap -o json | jq '.status.sync.revision'
# Should match: git rev-parse HEAD

# Force immediate sync:
argocd app sync bootstrap --force --prune
argocd app wait bootstrap --health --timeout 120
```

### Quick Cluster Health Check

```bash
# All in one:
kubectl get nodes --no-headers
kubectl get pods -A --no-headers | awk '{print $4}' | sort | uniq -c | sort -rn
kubectl get apps -n argocd --no-headers | grep -v "Synced.*Healthy"

# Proxmox memory (swap exhaustion check):
ssh -i ~/.ssh/deployer_ed25519 root@10.25.0.3 "free -m | grep -E 'Mem|Swap'"
```

---

## 4. Local Development (No Runner, No CI)

There are three ways to work locally, in order of increasing cluster access:

### Option A — Full Mock Stack (no cluster needed)

Uses `docker-compose.yml`. The API and console run against a static mock server.
No K8s, no Authentik, no git push needed. Best for UI work.

```bash
# Prerequisites: Docker Desktop or Docker Engine + docker compose

# Start everything:
cd InfraWeaver-platform
docker compose up --build

# Services:
#   Console  → http://localhost:3000  (mock auth, no real SSO)
#   API      → http://localhost:3001/health
#   Mock     → http://localhost:4010/health.json  (nginx serving dev/mock/)

# Tail logs:
docker compose logs -f console
docker compose logs -f api

# Stop:
docker compose down
```

The mock server (`dev/mock/`) is plain JSON files served by nginx.
Add new mock responses by dropping `.json` files under `dev/mock/api/`.

**Auth in mock mode:** The console's NextAuth is configured with dummy Authentik env vars
(`AUTHENTIK_CLIENT_ID: infraweaver-dev`). Login is bypassed — any session is accepted.

---

### Option B — API + Console Against Live Cluster (recommended for real testing)

Run the apps locally with your `~/.kube/config` pointing at the real cluster.
No Docker needed — just Node.js 20+.

**Step 1: Set up environment files**

```bash
# API — create apps/infraweaver-api/.env.local
cat > apps/infraweaver-api/.env.local << 'EOF'
PORT=3001
CONSOLE_URL=http://localhost:3000
CONSOLE_API_SECRET=dev-console-secret
ARGOCD_SERVER=https://argocd.int.rlservers.com
ARGOCD_TOKEN=<get from: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d>
MODE_NAMESPACE=infraweaver-console
EOF

# Console — create apps/infraweaver-console/.env.local
cat > apps/infraweaver-console/.env.local << 'EOF'
NEXTAUTH_URL=http://localhost:3000
AUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=dev-local-secret-change-me
AUTH_SECRET=dev-local-secret-change-me
INFRAWEAVER_API_URL=http://localhost:3001
AUTHENTIK_ISSUER=https://auth.rlservers.com/application/o/infraweaver/
AUTHENTIK_CLIENT_ID=<get from Authentik UI or OpenBao: secret/platform/infraweaver-console>
AUTHENTIK_CLIENT_SECRET=<get from Authentik UI or OpenBao>
AUTHENTIK_URL=https://auth.rlservers.com
GIT_PROVIDER=onedev
ONEDEV_URL=https://onedev.rlservers.com
ONEDEV_TOKEN=xAYtN6OEtKFkm788zY4u6OvaY6vlph
ONEDEV_PROJECT_PATH=InfraWeaver-platform
NEXT_PUBLIC_APP_VERSION=dev-local
EOF
```

**Step 2: Start the API**

```bash
cd apps/infraweaver-api
npm ci
npm run dev
# API is live at http://localhost:3001
# It auto-detects ~/.kube/config and uses the 'local' cluster context
# Test it: curl http://localhost:3001/health
```

**Step 3: Start the console**

```bash
# In a second terminal:
cd apps/infraweaver-console
npm install --legacy-peer-deps
npm run dev
# Console is live at http://localhost:3000
# It authenticates via real Authentik SSO at auth.rlservers.com
# Requires NetBird VPN to reach auth.rlservers.com
```

**Step 4: Verify the stack**

```bash
# API health (should show k8sApi: ok):
curl http://localhost:3001/health | jq .

# API talking to real cluster:
curl http://localhost:3001/api/v1/nodes | jq '.[].name'

# Console proxying through API (check browser Network tab for /api/* calls)
open http://localhost:3000
```

---

### Option C — Point API at Cluster via Port-Forward (no local Node.js needed)

If you only want to test API changes without running Node locally, deploy the change
to the cluster and call it through a port-forward:

```bash
# 1. Build and push the image:
cd apps/infraweaver-api
docker build -t onedev.rlservers.com/infraweaver/infraweaver-api:dev .
docker push onedev.rlservers.com/infraweaver/infraweaver-api:dev

# 2. Patch the deployment to use the dev image temporarily:
kubectl set image deploy/infraweaver-api \
  infraweaver-api=onedev.rlservers.com/infraweaver/infraweaver-api:dev \
  -n infraweaver-console

# 3. Port-forward and test:
kubectl port-forward -n infraweaver-console svc/infraweaver-api 3001:3001 &
curl http://localhost:3001/health | jq .

# 4. When done, ArgoCD self-healer will restore the correct image within ~5 min
#    Or force it: argocd app sync catalog-infraweaver-api-manifests
```

---

### Env Vars Quick Reference

| Variable | Where Used | How to Get |
|---|---|---|
| `ARGOCD_TOKEN` | API | `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d` |
| `AUTHENTIK_CLIENT_ID` | Console | Authentik UI → Applications → infraweaver → Edit, or OpenBao `secret/platform/infraweaver-console` |
| `AUTHENTIK_CLIENT_SECRET` | Console | Same source as above |
| `ONEDEV_TOKEN` | Console git-provider | `xAYtN6OEtKFkm788zY4u6OvaY6vlph` (admin password = token for HTTP basic auth) |
| `NEXTAUTH_SECRET` | Console | Any random string for local dev (e.g. `openssl rand -base64 32`) |
| `INFRAWEAVER_API_URL` | Console | `http://localhost:3001` for local, `http://infraweaver-api:3001` in-cluster |

### Testing Changes Without Pushing to Git

For console or API code changes that you want to verify before committing:

```bash
# Console: hot-reload is on by default with `npm run dev`
# Just edit the file — the browser updates automatically

# API: tsx watch restarts on every file save
# Just edit the file — curl the endpoint again

# To test a complete end-to-end flow (git install/uninstall):
# Set GIT_PROVIDER=github in .env.local and use a test branch:
GIT_BRANCH=test-$(date +%s) git checkout -b $GIT_BRANCH
# Make your change, push to origin only, test via console
# Then clean up: git checkout main && git branch -D $GIT_BRANCH
```

---

## 5. Kubernetes Structure

```
kubernetes/
├── bootstrap/          ← App-of-Apps: one YAML = one installed service
│   ├── core-*.yaml     ← Infrastructure (metallb, traefik, cert-manager, longhorn...)
│   ├── app-*.yaml      ← Platform services (authentik, grafana, netbird...)
│   └── catalog-*.yaml  ← Community apps (presence = installed, deletion = uninstall)
├── catalog/            ← Available app definitions
│   └── <slug>/
│       ├── catalog.yaml           ← App metadata (name, icon, category, ports)
│       └── manifests/             ← Deployment, Service, IngressRoute, PVC etc.
├── core/               ← Cluster-level config (limitranges, RBAC, priority classes)
├── platform/           ← Helm-based platform services
├── monitoring/         ← Prometheus, Loki, Alertmanager, Grafana
├── apps/               ← Non-catalog custom apps
└── crds/               ← Custom Resource Definitions
```

### Community App Uninstall Order (MUST follow or bootstrap deadlocks)

```bash
SLUG=myapp

# 1. Remove finalizer (non-blocking)
kubectl patch app -n argocd catalog-${SLUG}-manifests \
  --type=json -p '[{"op":"remove","path":"/metadata/finalizers"}]' 2>/dev/null || true

# 2. Delete namespace
kubectl delete namespace $SLUG --wait=false 2>/dev/null || true

# 3. Delete the ArgoCD Application
kubectl delete app -n argocd catalog-${SLUG}-manifests --wait=false 2>/dev/null || true

# 4. Remove bootstrap file from git
git rm kubernetes/bootstrap/catalog-${SLUG}-manifests.yaml
git commit -m "chore: uninstall ${SLUG}"
git push origin main && git push onedev main

# 5. Force bootstrap refresh
kubectl annotate app -n argocd bootstrap argocd.argoproj.io/refresh=hard --overwrite
```

**Why this order:** Deleting the git file BEFORE the ArgoCD Application object causes
bootstrap to enter a retry loop (100x backoff) trying to prune the orphan object. This
makes bootstrap show Degraded for minutes. Always clear the object first.

### Fix Bootstrap Stuck in Degraded

```bash
kubectl patch app -n argocd bootstrap \
  --type=json -p '[{"op":"remove","path":"/status/operationState"}]' 2>/dev/null || true
kubectl annotate app -n argocd bootstrap argocd.argoproj.io/refresh=hard --overwrite
# If repo cache is stale:
kubectl rollout restart deployment/argocd-repo-server -n argocd
```

---

## 6. What Is Broken

### 🔴 Console Calls Kubernetes Directly (~18 routes)

The console imports `@kubernetes/client-node` and calls the K8s API directly in violation
of the Console → API → K8s rule. Routes to migrate:

```
src/app/api/community-apps/[slug]/route.ts     ← finalizer removal
src/app/api/community-apps/deploy/route.ts     ← app status check
src/app/api/secrets/route.ts
src/app/api/platform/status/route.ts
src/app/api/network/topology/route.ts
src/app/api/network/policies/route.ts
src/app/api/config-maps/route.ts
src/app/api/cluster/node-pods/route.ts
src/app/api/cluster/memory-heatmap/route.ts
src/app/api/cluster/pod-metrics/route.ts
src/app/api/cluster/cost/route.ts
src/app/api/cluster/namespace-cleanup/route.ts
src/app/api/cluster/rollout/route.ts
src/app/api/cluster/nodes/[name]/cordon/route.ts
src/app/api/cluster/nodes/route.ts
src/app/api/cluster/export/route.ts
src/app/api/pods/exec/route.ts
```

**Fix pattern:**
1. Add the equivalent route to `apps/infraweaver-api/src/routes/`
2. Replace the console route body with `fetch(process.env.INFRAWEAVER_API_URL + '/api/v1/...')`
3. Delete the K8s import from the console route

### 🔴 Orphan Proxmox Process Eating 7GB

VM 9300 is a zombie QEMU process (PID 37218) stuck in D-state since April 28. It holds
5.7GB swap + 1.4GB RAM. `kill -9` does not work on D-state processes.
**Fix:** Schedule Proxmox host reboot. After reboot: `lvremove -f /dev/Storage/vm-9300-disk-0`

### 🟡 Onedev SSO Returns `invalid_client`

Authentik OIDC provider for Onedev has wrong client auth method.
**Fix:** Set Authentik OIDC provider → Client auth method = `client_secret_post`

### 🟡 Console git-provider Defaults to GitHub

`GIT_PROVIDER` env var defaults to `github` even in-cluster. All install/uninstall ops go
via GitHub API (slow, rate-limited).
**Fix:** Set `GIT_PROVIDER=onedev` in `kubernetes/catalog/infraweaver-console/manifests/` env.

### 🟡 Update Manager Shows Wildcards

`9.*` / `v1.*` shown as "current version". Partially fixed in `b52c6b22`. Available versions
dropdown still needs Helm repo index.yaml query (`<repoURL>/index.yaml` → filter by chart).

### 🟡 kubeconfig Hardcoded to CP1

When CP1 reboots (rolling reboot pattern), kubectl fails for minutes.
**Fix:** Add a VIP via MetalLB `10.10.0.200` for kube-apiserver, or use round-robin DNS.

---

## 7. TODO List

### Priority 1 — Stability

| Task | Detail |
|---|---|
| Reboot Proxmox host | Kill orphan VM 9300 (PID 37218, 7GB swap). SSH: `root@10.25.0.3`. After reboot: `lvremove -f /dev/Storage/vm-9300-disk-0` |
| Fix Onedev SSO | Authentik OIDC provider for Onedev → set `Client auth method: client_secret_post`. Test at `onedev.rlservers.com` |
| Switch GIT_PROVIDER to onedev | Add `GIT_PROVIDER=onedev` to console deployment env + ExternalSecret. Files in `kubernetes/catalog/infraweaver-console/manifests/` |
| Fix control plane VIP | Hardcoded `10.10.0.90:6443` fails on CP1 reboot. Add MetalLB VIP or round-robin across all 3 CPs |

### Priority 2 — Architecture

| Task | Detail |
|---|---|
| Migrate console K8s routes to API | See Section 5. Start with `community-apps/[slug]` and `community-apps/deploy`. Pattern: add route to `infraweaver-api/src/routes/`, call via `fetch()` in console |
| Add bulk app actions API | `POST /api/v1/apps/bulk` with `action: start\|stop\|remove\|sync` and `apps: string[]` in infraweaver-api |
| Simplify community app uninstall | Make idempotent: patch finalizer → delete file → delete app → return 202. Let ArgoCD clean up the rest |

### Priority 3 — Developer Experience

| Task | Detail |
|---|---|
| Fix Update Manager available versions | Query `<repoURL>/index.yaml` per app. Config in `apps/infraweaver-api/src/config/version-sources.ts` |
| Automate Onedev bootstrap | `scripts/bootstrap.sh` should: clone → deploy Onedev → mirror repo → switch ArgoCD source → set `GIT_PROVIDER=onedev` |
| Add GitHub↔Onedev sync health check | Daily workflow in `.github/workflows/maintenance.yml` verifying both remotes are at same HEAD |
| Enable memory ballooning | Talos VMs have `balloon:0`. Check Talos virtio-balloon support. Or reduce TrueNAS from 8GB to 6GB after installing qemu-guest-agent |

### Priority 4 — UI Simplification

| Task | Detail |
|---|---|
| Fix Authentik infinite load | After SSO login, sometimes infinite-loads. Check: React hydration mismatch, OIDC callback redirect loop, token race in `middleware.ts` |
| Remove sticky header, add FAB | Header blocks content on desktop. Make it non-sticky. Add floating action button (bottom-right) with context-aware actions (per-page: game hub → "Create Server", apps → "Install App") |
| Mass-select in Apps page | Checkboxes + bulk actions: start, stop, remove, resync. Calls `POST /api/v1/apps/bulk` |

---

## 8. Public URLs

| Service | URL | Auth |
|---|---|---|
| Console | `https://infraweaver.int.rlservers.com` | Authentik SSO |
| API | `https://api.int.rlservers.com` | Bearer token |
| ArgoCD | `https://argocd.int.rlservers.com` | admin / `GS8Su3jXVNDODVb8` |
| Authentik | `https://auth.rlservers.com` | admin user |
| Onedev | `https://onedev.rlservers.com` | admin / `xAYtN6OEtKFkm788zY4u6OvaY6vlph` |
| Grafana | `https://grafana.int.rlservers.com` | Authentik SSO |
| Longhorn | `https://longhorn.int.rlservers.com` | Authentik SSO |
| Netbird | `https://netbird.rlservers.com` | Authentik SSO |

All `.int.rlservers.com` URLs require NetBird VPN connection.

---

## 9. Architecture Principles (Non-Negotiable)

1. **GitOps is truth.** Never `kubectl apply` anything not in git. Emergency fix? Commit after.
2. **Console is display-only.** It reads state and calls infraweaver-api. It never calls K8s.
3. **API owns all mutations.** Sync, delete, restart, exec — all go through infraweaver-api.
4. **Secrets live in OpenBao.** Nothing sensitive in git or ConfigMaps. ESO syncs to K8s Secrets.
5. **Onedev is the ArgoCD source.** GitHub is the public mirror. In-cluster ops use Onedev.
6. **Community apps are Git-defined.** A bootstrap YAML = installed. No file = not installed.
7. **Simplify everything.** Every PR should have more deletions than additions.

---

## 10. Key Files Quick Reference

| File | What It Does |
|---|---|
| `apps/infraweaver-console/src/lib/git-provider.ts` | All git ops. `GIT_PROVIDER` env switches GitHub↔Onedev |
| `apps/infraweaver-api/src/routes/updates.ts` | Update Manager version logic |
| `apps/infraweaver-api/src/config/version-sources.ts` | Helm repo URLs per app (for version lookup) |
| `apps/infraweaver-console/src/app/api/community-apps/[slug]/route.ts` | Community app uninstall |
| `apps/infraweaver-console/src/app/api/community-apps/deploy/route.ts` | Community app install |
| `kubernetes/bootstrap/` | One YAML per installed service |
| `kubernetes/catalog/` | Available app definitions |
| `kubernetes/core/argocd/manifests/self-healer.yaml` | CronJob that auto-syncs OutOfSync apps |
| `.github/memories/` | 94 knowledge files — always read before touching a component |
| `scripts/lib.sh` | Shared bash functions. Source before writing any script |

---

_This file is maintained by AI agents. After any task, update the relevant section and write
a memory file in `.github/memories/` if you discovered a new pattern or gotcha._
