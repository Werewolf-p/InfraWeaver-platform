# Workflow Improvements — May 2026

## apply-changes.yml Bugs Fixed

### Job reference bug (was: failing at 0s)
- `needs.apply-users.outputs.recovery_links_json` → `steps.recovery.outputs.links_json`
  - The step ID is `recovery` (in `seed-openbao` job), output key is `links_json`
- `post-health-check` had `needs: [detect, apply-users, ...]` → `needs: [detect, seed-openbao, ...]`
  - `apply-users` job never existed; the seed+users logic is in `seed-openbao` job

### post-health-check improvements (M9 research item)
- Replaced single-app Authentik check with `scripts/deploy/check-argocd-health.sh`
- Health gate checks ALL ArgoCD apps for Healthy+Synced
- Critical apps gate: core-argocd-manifests, apps-authentik-manifests, core-external-secrets-manifests, core-traefik-manifests
- Non-critical degraded apps are warnings only (no job failure)
- GitHub Step Summary table shows all apps with ✅/❌/⏳ icons
- Added `uses: actions/checkout` to post-health-check job (needed for scripts/)

### ci.yml fix
- `${{ runner.home }}` is not a valid GitHub Actions expression
- Fixed to `~/.kube/config-platform-productie` (literal home dir — self-hosted runner)

## Proxmox OIDC Automation (sso-2)
- `configure-oidc.sh` now automatically configures the `authentik` OpenID realm in PVE
- Uses Proxmox REST API (`POST /api2/json/access/realms`) to create/update realm
- Checks if realm exists first (PUT for update, POST for create)
- Reads `proxmox_host` from `envs/<env>/cluster.yaml`
- Requires `PROXMOX_API_TOKEN` env var (now passed from secret in full-redeploy.yml)
- Falls back gracefully with manual instructions if token/host not available

## check-argocd-health.sh Script
Location: `scripts/deploy/check-argocd-health.sh`
- Standalone: `ENV_NAME=productie WAIT_MINUTES=5 bash scripts/deploy/check-argocd-health.sh`
- Polls all ArgoCD apps every 15s for up to WAIT_MINUTES (default: 5)
- Writes GitHub Step Summary table with all app statuses
- Fails if any CRITICAL_APPS are not Healthy+Synced at timeout
