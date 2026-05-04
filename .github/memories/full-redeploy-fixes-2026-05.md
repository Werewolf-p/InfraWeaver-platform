# Full Redeploy Fixes & Testing — 2026-05

## Critical Fixes Applied

### 1. YAML Duplicate Key Bug (fixed)
- "Fix ingress-nginx admission webhook" step had NO `- name:` declaration — was a duplicate `run:` key inside another step
- Go's yaml.v3 silently keeps the FIRST value when duplicate keys exist — ingress-nginx code was never running
- Fix: added proper `- name: Fix ingress-nginx admission webhook` step declaration

### 2. Stale Pod Name Bug (fixed 2026-05-04)
- `WORKER_POD` variable captured once at step start, used 2–3 minutes later after `_wait_for_user` loop
- During the wait, worker pod was replaced (rolling update/restart) → `container not found ("worker")`
- Fix: replaced ALL `$WORKER_POD` references with `deploy/authentik-worker -c worker`
  - Kubernetes routes `kubectl exec deploy/X` to the current live pod at execution time
  - Applied in: `full-redeploy.yml` (3 steps) + `apply-changes.yml` (3 steps)
- The container inside `authentik-worker-<hash>` pods is named `worker` (must use `-c worker`)

### 3. Staging LE Support (added 2026-05)
- Added `letsencrypt-http-staging` and `letsencrypt-cloudflare-staging` ClusterIssuers
- Added `letsencrypt_env` workflow_dispatch input (staging/production, default=production)
- "Configure certificate issuers" step patches all Certificate resources when staging
- "Refresh TLS secret backup" skips when staging

## Test Results (2026-05-04)

### Staging Redeploy (run 25343889809): ✅ ALL 29 STEPS PASSED (26m52s)
### Production Redeploy (run 25345158389): ✅ ALL 29 STEPS PASSED (29m2s)

### Post-Deploy Checks ✅
- All ArgoCD apps Synced/Healthy (except external-routes=Degraded due to BareMetalEndpoint health unknown — expected)
- NetBird: router peer connected, routing-peers-vlan3 group has 1 peer, both routes (10.10.0.0/24, 10.25.0.0/24) enabled
- Users: remon superuser=True groups=[authentik Admins, platform-admins, platform-users]; ardaty superuser=False groups=[platform-users]  
- TLS: int.rlservers.com wildcard=True (letsencrypt-cloudflare), rlservers.com wildcard=True (letsencrypt-http)
- OpenBao: unsealed, HA enabled, v2.5.3
- ArgoCD OIDC configured for Authentik
- Sync-change test: homepage updated → Synced:Healthy in ~90s, NetBird router stayed connected ✅

### Known Non-Issues
- `external-routes Degraded`: BareMetalEndpoints health is unknown to ArgoCD — not a real problem
- waterdance-nl/yonavaarwater-nl/zonnevaarwater-nl certs: LE rate limit on customer domains (429, retry after 168h)
- `core-argocd-manifests Unknown`, `core-metallb-manifests Unknown`, `apps-example-app Unknown`: ArgoCD health unknown for some CRD types — normal

## NetBird Technical Details
- Management API not reachable from CI runner directly — must port-forward to pod
- Static IDs: account=acc00000-0000-4000-a000-000000000001, all-group=grp00000-0000-4000-a000-000000000001, routing-group=grp00000-0000-4000-a000-000000000002
- Router VM: 10.10.0.10 (ubuntu user), management VIP: 10.10.0.202
- Bootstrap job runs on every apps-netbird sync — populates routing group automatically

## Workflow File Notes
- full-redeploy.yml: 29 properly-named steps, valid YAML confirmed
- apply-changes.yml: Uses deploy/ target for all authentik worker exec calls
- create-new-users.py: Accepts worker_pod arg but doesn't use it (legacy interface, safe to keep)
