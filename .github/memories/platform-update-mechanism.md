# Platform Update Mechanism

## How It Works
- GitHub releases at `https://github.com/werewolf-p/infraweaver` drive updates
- `GET /api/v1/platform/version` — checks current vs latest GitHub release tag
- `POST /api/v1/platform/update` — rewrites image tags in manifest YAMLs and triggers ArgoCD hard-refresh
- Both endpoints require `cluster:admin` RBAC

## Image Rewrite Logic (platform.ts)
- DEPLOYMENT_MANIFESTS maps app names → manifest YAML paths in `/app/kubernetes/...`
- `rewriteImageTag(yaml, appName, newTag)` finds `/${appName}:` pattern in YAML and replaces with `ghcr.io/werewolf-p/infraweaver-${appName}:${newTag}`
- **BUG FIXED (2026-05)**: regex was `/infraweaver-${appName}:` but appName is already `infraweaver-api` → double prefix → never matched. Fixed to `/${appName}:`
- After rewrite, ArgoCD hard-refresh is triggered for each app via ArgoCD REST API

## Required Secrets
- `infraweaver-api-argocd-token` (in `infraweaver-console` ns): must contain `ARGOCD_TOKEN` env var
  - ArgoCD token from `infraweaver-console-secret.argocd-token` in OpenBao
  - Current value: FaTpIfoXKPf5bs67fPT6NkQl
  - Uses `envFrom: secretRef: optional: true` → pod starts fine even if missing, but ArgoCD calls silently fail
- `GITHUB_TOKEN` env var (optional): enables `ensureGhcrPullSecret()` to create ghcr.io pull secrets
  - If not set, `ghcr.io` packages must be publicly accessible

## ghcr.io Pull Secret (`ensureGhcrPullSecret`)
- Called before ArgoCD refresh in POST /update
- Creates `ghcr-pull-secret` in both `infraweaver-console` and `infraweaver-system` ns
- Uses `GITHUB_TOKEN` as ghcr.io password
- Secret is a `kubernetes.io/dockerconfigjson` type
- Is a no-op if `GITHUB_TOKEN` is empty
- **BUG FIXED (2026-05)**: k8s client API calls used wrong signatures (positional args vs object arg for v1.4.0)

## Deployment Manifests
- All 3 manifests now have `ghcr-pull-secret` in imagePullSecrets alongside `onedev-pull-secret`
- infraweaver-node deployment was missing imagePullSecrets entirely — fixed

## ArgoCD App Names
- `catalog-infraweaver-api-manifests`
- `catalog-infraweaver-console-manifests`
- `catalog-infraweaver-node-manifests`
- Trigger hard-refresh via annotation: `argocd.argoproj.io/refresh=hard`
- Or via ArgoCD API: `POST /api/v1/applications/{name}/sync` with Bearer token

## To Enable Updates from GitHub
1. Push a version tag to GitHub: `git tag v0.1.0 && git push github v0.1.0`
2. Ensure GitHub packages are publicly accessible (Settings → Packages → Public)
3. OR set GITHUB_TOKEN env var in the API deployment secret

## Build Process
- TypeScript source: `apps/infraweaver-api/src/routes/platform.ts`
- Build: `cd apps/infraweaver-api && npm run build` (uses node --max_old_space_size=512)
- Container: `buildah bud --no-cache -f Dockerfile.prebuilt` (**always use --no-cache**)
  - Without --no-cache, buildah may use a cached layer with corrupt npm packages
- Push: `buildah push onedev.rlservers.com/infraweaver-platform/infraweaver-api:main-<sha>`

## OpenBao Autounseal
- OpenBao uses Shamir with 1 share, autounseal sidecar in pod
- Sidecar checks every 30s, reads from `/etc/openbao-unseal/unseal_key` volume
- Volume comes from `openbao-unseal` k8s secret in `openbao` ns
- If OpenBao stays sealed for >30s (e.g., after restart + sidecar timing), ExternalSecrets fail
- Manual unseal: `kubectl exec openbao-0 -n openbao -- bao operator unseal $(kubectl get secret openbao-unseal -n openbao -o jsonpath='{.data.unseal_key}' | base64 -d)`

## Kubernetes Client API (v1.4.0)
- createNamespacedSecret: `createNamespacedSecret({ namespace, body })`
- replaceNamespacedSecret: `replaceNamespacedSecret({ name, namespace, body })`
- Both use request object form (NOT positional args)
- Reference: `src/lib/cluster-registry.ts` lines 213, 229
