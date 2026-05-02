---
title: Post-Deploy Test Suite
description: scripts/test-post-deploy.sh — 31 automated tests run after every full redeploy.
---

# Post-Deploy Test Suite

## Location
`scripts/test-post-deploy.sh`

## Usage
```bash
bash scripts/test-post-deploy.sh <kubeconfig> <env>
# Example:
bash scripts/test-post-deploy.sh ~/.kube/config-platform-productie productie
```

## Test Categories (31 tests)
1. **Cluster** — all 3 nodes Ready
2. **Core Services** — ExternalSecrets, Traefik, Authentik server+worker, ArgoCD, OpenBao pod
3. **ArgoCD App Health** — core-openbao, core-cert-manager, core-traefik, core-argocd, apps-authentik, external-routes (warn), apps-dns, apps-homepage, apps-netbird
4. **Public URLs** — Authentik login/admin/recovery, NetBird dashboard/API
5. **OIDC Discovery** — ArgoCD & OpenBao issuer endpoints
6. **SSO Config** — ArgoCD OIDC secret, OpenBao OIDC auth + role
7. **TLS Secrets** — rlservers-com-wildcard-tls (fail if missing), int-rlservers-com-tls (warn if missing)
8. **VPN-Only Enforcement** — argocd.int, argocd.rlservers.com, openbao.int not publicly reachable
9. **ArgoCD OIDC Config** — argocd-cm url = argocd.int.rlservers.com

## Known Warnings (expected, non-fatal)
- `int-rlservers-com-tls missing` — Let's Encrypt rate limit (restored from backup on next redeploy)
- `external-routes Degraded` — Pre-existing ArgoCD aggregate health quirk; all resources are Synced/Healthy

## Key Technical Notes
- OpenBao is a **StatefulSet**, not a Deployment — checked via `openbao-0` pod readiness
- `http_must_not_reach` uses `curl -s` without `|| echo "000"` (avoids double-echo producing "000000")
- TLS cert missing → warn (rate-limited) or warn (cert-manager object not found)
- ArgoCD OIDC check: looks for `url` key in argocd-cm, not the Authentik issuer URL

## Integration with full-redeploy.yml
The test step runs automatically after `Configure OIDC for ArgoCD and OpenBao`:
```yaml
- name: Run post-deploy tests
  run: |
    bash scripts/test-post-deploy.sh ~/.kube/config-platform-${{ env.ENV_NAME }} ${{ env.ENV_NAME }} || true
```
Uses `|| true` so test failures don't block the deploy email.
