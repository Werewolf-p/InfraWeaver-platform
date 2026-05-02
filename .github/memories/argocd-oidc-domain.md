---
title: ArgoCD OIDC — VPN-Only Domain & SSO Configuration
description: ArgoCD is VPN-only at argocd.int.rlservers.com. global.domain drives OIDC callback URL. Public ingress must be manually cleaned up.
---

# ArgoCD OIDC & VPN-Only Domain

## Domain Migration (May 2026)

ArgoCD was moved from `argocd.rlservers.com` (public) to `argocd.int.rlservers.com` (VPN-only).

### Changes Made
- `kubernetes/core/argocd/values.yaml`: `global.domain: argocd.int.rlservers.com`, ingress `enabled: false`
- `kubernetes/apps/authentik/manifests/blueprint-apps.yaml`: redirect URI → `argocd.int.rlservers.com/auth/callback`
- `kubernetes/core/argocd/manifests/ingress-rlservers.yaml`: **DELETED** (was public Ingress)
- `.github/workflows/full-redeploy.yml`: cleanup step deletes stale `argocd-server-rlservers` ingress

### Why `global.domain` Matters
ArgoCD derives its OIDC callback URL from `global.domain`:
```
callback = https://<global.domain>/auth/callback
```
This MUST exactly match the `redirect_uris` in the Authentik OAuth2 provider blueprint.
The `argocd-cm` ConfigMap gets `url: https://<global.domain>` from the Helm chart.

## Stale Ingress Issue

The `argocd-server-rlservers` Ingress has NO Helm or ArgoCD tracking labels.
- Created outside ArgoCD tracking, so `prune: true` does NOT remove it
- The `Deploy ArgoCD & Bootstrap` step in full-redeploy.yml explicitly deletes it:
  ```bash
  kubectl delete ingress argocd-server-rlservers -n argocd 2>/dev/null || true
  ```

## Authentik Blueprint (blueprint-apps.yaml)
```yaml
# ArgoCD provider redirect URI
redirect_uris: "https://argocd.int.rlservers.com/auth/callback"

# OpenBao provider redirect URIs (both needed)
redirect_uris: |
  https://openbao.int.rlservers.com/ui/vault/auth/oidc/oidc/callback
  http://localhost:8250/oidc/callback
```

## Post-Deploy Verification
The test suite at `scripts/test-post-deploy.sh` checks:
- ArgoCD url in argocd-cm = `https://argocd.int.rlservers.com`
- OIDC discovery endpoint for ArgoCD returns correct issuer
- `argocd.rlservers.com` is NOT publicly reachable
- `argocd.int.rlservers.com` is NOT publicly reachable (VPN-only expected)
