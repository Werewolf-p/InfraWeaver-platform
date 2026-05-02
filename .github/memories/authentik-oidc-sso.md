# Authentik OIDC SSO — ArgoCD + OpenBao

## Architecture
Authentik acts as the IdP for ArgoCD and OpenBao via confidential OAuth2/OIDC.
Both providers are created via `blueprint-apps.yaml`.

## Blueprint File
`kubernetes/apps/authentik/manifests/blueprint-apps.yaml`
- Registered in `kubernetes/apps/authentik/values.yaml` → `blueprints.configMaps`
- Deployed via `apps-authentik-manifests` ArgoCD Application (watches `manifests/` dir)
- Creates:
  - `ArgoCD Provider` (client_id: `argocd`, confidential)
    - redirect_uri: `https://argocd.rlservers.com/auth/callback`
  - `OpenBao Provider` (client_id: `openbao`, confidential)
    - redirect_uris: `https://openbao.int.rlservers.com/ui/vault/auth/oidc/oidc/callback`
    - `http://localhost:8250/oidc/callback` (for bao CLI)

## ArgoCD Config (`kubernetes/core/argocd/values.yaml`)
```yaml
configs:
  cm:
    oidc.config: |
      name: Authentik
      issuer: https://auth.rlservers.com/application/o/argocd/
      clientID: argocd
      clientSecret: $oidc.authentik.clientSecret
      requestedScopes: [openid, profile, email]
  rbac:
    policy.csv: |
      g, remon, role:admin
```
The `$oidc.authentik.clientSecret` is read from K8s secret `argocd-secret` key `oidc.authentik.clientSecret`.

## Workflow Bootstrap (`Configure OIDC for ArgoCD and OpenBao` step)
Runs after `Set Authentik admin privileges` step (which saves `AUTHENTIK_ADMIN_TOKEN` to GITHUB_ENV).

1. Reads ArgoCD client_secret from Authentik API: `GET /api/v3/providers/oauth2/?name=ArgoCD%20Provider`
2. Patches `argocd-secret` in namespace `argocd` with key `oidc.authentik.clientSecret`
3. Reads OpenBao client_secret from Authentik API
4. Runs on `openbao-0` pod:
   - `bao auth enable oidc`
   - `bao write auth/oidc/config` (issuer: `https://auth.rlservers.com/application/o/openbao/`)
   - `bao policy write admin` (all capabilities)
   - `bao write auth/oidc/role/default` (user_claim: preferred_username, policies: admin)

## OIDC Discovery URLs
- ArgoCD: `https://auth.rlservers.com/application/o/argocd/.well-known/openid-configuration`
- OpenBao: `https://auth.rlservers.com/application/o/openbao/.well-known/openid-configuration`

## IMPORTANT: Column-0 YAML gotcha
Any content at column 0 in the workflow YAML breaks GitHub's parser and returns
"Workflow does not have 'workflow_dispatch' trigger". Use base64 for multiline
scripts/policies (heredocs go to column 0).

## Recovery Flow Fix
`blueprint-branding.yaml` must include FlowStageBindings for the recovery flow:
- `default-password-change-prompt` (order 0) — PromptStage
- `default-password-change-write` (order 10) — UserWriteStage
Without these, recovery URLs redirect to login immediately (empty flow bounces).
