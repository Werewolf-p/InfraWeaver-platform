# Authentik OIDC SSO — ArgoCD + OpenBao

## Architecture
Authentik acts as the IdP for ArgoCD and OpenBao via confidential OAuth2/OIDC.
Both providers are created via `blueprint-apps.yaml`.

## Blueprint File
`kubernetes/platform/authentik/manifests/blueprint-apps.yaml`
- Registered in `kubernetes/platform/authentik/values.yaml` → `blueprints.configMaps`
- Deployed via `apps-authentik-manifests` ArgoCD Application (watches `manifests/` dir)
- Creates:
  - `ArgoCD Provider` (client_id: `argocd`, confidential)
    - redirect_uri: `https://argocd.int.rlservers.com/auth/callback`
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
The `$oidc.authentik.clientSecret` is read from K8s secret `argocd-secret` key `oidc.clientSecret`
(note: ArgoCD expects `oidc.clientSecret`, NOT `oidc.authentik.clientSecret` — the values.yaml
`clientSecret: $oidc.authentik.clientSecret` maps to `argocd-secret` key `oidc.authentik.clientSecret`).

## Workflow Bootstrap (`Configure OIDC for ArgoCD and OpenBao` step)

### Port-forward required (TLS cert may not be ready yet)
All Authentik API calls in the workflow use `kubectl port-forward svc/authentik-server -n authentik 8088:80`
(HTTP, port 8088 for OIDC step, 8089 for admin step) instead of HTTPS because:
- Traefik serves self-signed `TRAEFIK DEFAULT CERT` if LE cert not yet issued
- curl/kubectl fail TLS validation against this cert
- Port-forward bypasses Traefik entirely → HTTP, no TLS issues

### OpenBao OIDC requires valid TLS
`bao write auth/oidc/config oidc_discovery_url=https://auth.rlservers.com/...`
OpenBao fetches the OIDC discovery URL and validates TLS. This fails if Traefik serves self-signed cert.
Fix: wait for `rlservers-com-wildcard` cert to be Ready before writing OIDC config.

### Bootstrap steps:
1. Reads ArgoCD client_secret from Authentik API: `GET /api/v3/providers/oauth2/?page_size=50`
2. Patches `argocd-secret` in namespace `argocd` with key `oidc.clientSecret`
3. Reads OpenBao client_secret from Authentik API
4. Waits for `rlservers-com-wildcard` TLS cert to be Ready
5. Runs on `openbao-0` pod:
   - `bao auth enable oidc`
   - `bao write auth/oidc/config` (issuer: `https://auth.rlservers.com/application/o/openbao/`)
   - `bao policy write admin` (all capabilities)
   - `bao write auth/oidc/role/default` (user_claim: preferred_username, policies: admin)

## OIDC Discovery URLs
- ArgoCD: `https://auth.rlservers.com/application/o/argocd/.well-known/openid-configuration`
- OpenBao: `https://auth.rlservers.com/application/o/openbao/.well-known/openid-configuration`

## Authentik Migration Crash Loop (fresh DB)
On a fresh PostgreSQL DB, Authentik runs 292+ Django migrations on first start.
`authentik_core.0056_user_roles` queries `authentik_tenants_tenant.reputation_lower_limit`
before that column's migration runs → `UndefinedColumn` crash.

**Fix applied in `kubernetes/platform/authentik/values.yaml`:**
```yaml
server:
  livenessProbe:
    initialDelaySeconds: 120
    failureThreshold: 30
worker:
  livenessProbe:
    initialDelaySeconds: 120
    failureThreshold: 30
```
This gives 120 + 300s = 7+ minutes for migrations on fresh DB.
Each restart persists partial migration state to PostgreSQL; subsequent starts have fewer pending migrations.

## ArgoCD Secret Key Name
The `argocd-secret` OIDC key name is `oidc.clientSecret` when using the argocd Helm chart default.
Patch command:
```bash
KT="kubectl --kubeconfig $KB --insecure-skip-tls-verify"
SECRET_B64=$(echo -n "$ARGOCD_SECRET" | base64 -w0)
$KT patch secret argocd-secret -n argocd --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/data/oidc.clientSecret\",\"value\":\"$SECRET_B64\"}]"
```

## IMPORTANT: Column-0 YAML gotcha
Any content at column 0 in the workflow YAML breaks GitHub's parser and returns
"Workflow does not have 'workflow_dispatch' trigger". Use base64 for multiline
scripts/policies (heredocs go to column 0).

## Recovery Flow Fix
`blueprint-branding.yaml` must include FlowStageBindings for the recovery flow:
- `default-password-change-prompt` (order 0) — PromptStage
- `default-password-change-write` (order 10) — UserWriteStage
Without these, recovery URLs redirect to login immediately (empty flow bounces).

## Bootstrap Token Secret
Bootstrap token is in secret `authentik-secrets` (not `authentik-bootstrap-credentials`):
```bash
BOOTSTRAP_TOKEN=$(kubectl get secret authentik-secrets -n authentik \
  -o jsonpath='{.data.bootstrap-token}' | base64 -d)
```
