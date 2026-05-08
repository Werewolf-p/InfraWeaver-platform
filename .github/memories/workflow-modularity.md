# Workflow Modularity — InfraWeaver Platform

## What Was Done

### full-redeploy.yml: 2,040 → 637 lines
Extracted 13 large inline bash blocks to `scripts/deploy/`:

| Script | Lines | Purpose |
|--------|-------|---------|
| `bootstrap-openbao.sh` | 438 | Init/unseal OpenBao, seed all platform secrets |
| `configure-oidc.sh` | 245 | OIDC for ArgoCD, OpenBao, all SSO integrations |
| `bootstrap-externalsecrets.sh` | 147 | ESO bootstrap + TLS restore |
| `configure-authentik.sh` | 111 | Admin privileges, groups, SSO providers |
| `deploy-argocd.sh` | 85 | Deploy ArgoCD + bootstrap ApplicationSets |
| `bootstrap-storage.sh` | 61 | local-path-provisioner + readiness wait |
| `send-welcome-emails.sh` | 56 | Welcome/recovery emails to non-admin users |
| `populate-netbird.sh` | 56 | NetBird routing groups + policies |
| `set-user-passwords.sh` | 56 | Force-set Authentik passwords from K8s secrets |
| `reconnect-netbird.sh` | 47 | Reconnect NetBird router VM after redeploy |
| `refresh-tls-backup.sh` | 44 | Backup TLS secrets to TrueNAS |
| `ensure-cloudflare-dns.sh` | 47 | Cloudflare DNS record management |
| `install-tools.sh` | 45 | Install tofu, talosctl, kubectl, helm, sops, age |

### apply-changes.yml: 620 → 506 lines
Extracted 2 more:

| Script | Lines | Purpose |
|--------|-------|---------|
| `generate-recovery-links.sh` | 65 | Authentik recovery links for new users |
| `seed-user-secrets.sh` | 61 | Seed new user secrets into OpenBao |

### New Validation Scripts
- `scripts/validate-platform-yaml.sh` — validates all enabled apps have catalog dirs
- `scripts/validate-users-yaml.sh` — validates required fields + valid access_levels
- Both added to `ci.yml` as `schema-validate` job (part of CI gate)

### Makefile Additions
New targets added to existing Makefile:
- `make validate-platform` — run platform.yaml validation
- `make validate-users` — run users.yaml validation
- `make validate-all` — all validations
- `make status` — ArgoCD app health summary
- `make diff` — kubectl diff kubernetes/ vs cluster
- `make apps` — list all ArgoCD apps
- `make users-list` — list users from users.yaml
- `make install-dev-tools` — yamllint, kubeconform, pre-commit
- `make clean` — remove __pycache__ and temp files

## Script Conventions

All `scripts/deploy/*.sh` scripts follow this pattern:
```bash
#!/usr/bin/env bash
set -euo pipefail

: "${ENV_NAME:?Usage: ENV_NAME=productie bash $0}"

# Cleanup on exit
cleanup() {
  kill ${PF_PID} 2>/dev/null || true
  rm -f /tmp/...;
}
trap cleanup EXIT

KB=~/.kube/config-platform-${ENV_NAME}
```

### Running Scripts Locally
```bash
ENV_NAME=productie bash scripts/deploy/configure-oidc.sh
ENV_NAME=productie bash scripts/deploy/bootstrap-openbao.sh
```

### Environment Variables Needed
Each script accepts `ENV_NAME` + any secret env vars (AUTHENTIK_ADMIN_TOKEN, etc.).
These are injected by the workflow via the `env:` block on the step or job.

## Key Decisions
- Scripts use `${ENV_NAME}` (shell var), not `${{ env.ENV_NAME }}` (Actions expr)
- `trap cleanup EXIT` added to all scripts with port-forwards
- Scripts are standalone-runnable for local debugging
- `set -euo pipefail` in all scripts for strict error handling
