# Platform config migration — generic / config-driven console

This refactor makes the console fork-retargetable from **one declarative,
git-backed source**: the `identity:` block in `InfraWeaver-infra/platform.yaml`
(reconciled by ArgoCD). Code derives hostnames, image refs, OIDC URLs, TLS
secret names, allowlists, and the homepage service map from it.

## What changed

| New / changed | Purpose |
|---|---|
| `src/lib/platform-config.ts` (new) | Sync, **client-safe** single source of truth: typed defaults, derivation helpers (`tlsSecretForHost`, `argocdApiBase`, `registryImageRef`, …), the `identity:` Zod schema, and `envAndDefaultIdentity` / `overlayIdentity`. |
| `src/lib/platform-config-server.ts` (new) | **Server-only** resolver `getPlatformIdentity()` (git → env → default, 30 s cache). Imports node-only git-provider — never import from a client component. |
| `src/lib/with-auth.ts` (new) | `withAuth(options, handler)` wrapper collapsing `auth → 401 → RBAC → 403 → rate-limit → 429 → try/catch → safeError → 500`, plus `json()` / `apiError()`. |
| `access-tier.ts`, `internal-url-allowlist.ts`, `homepage-service-config.ts`, `api/config/catalog-apps/route.ts` | Their hardcoded lists now come from `platform-config` (defined once). |
| `InfraWeaver-infra/platform.yaml` | New documented `identity:` block (`${PLACEHOLDER}` values, fork model). |
| `InfraWeaver-infra/scripts/validate-platform-yaml.sh` | New `identity:` shape validation (runs under `validate-iac.sh`). |
| Routes migrated to `withAuth` | `argocd/apps/[name]/delete`, `cluster/cordon`, `cluster/scale`, `config/platform` (PUT). Behaviour byte-identical. |

`app/api/feedback/route.ts` `FEEDBACK_URL` remains intentionally hardcoded.

## Resolution precedence (server runtime)

1. **git** — `identity:` in `platform.yaml` (un-substituted `${...}` tokens are ignored)
2. **env** — existing vars (below)
3. **typed default** — equals today's literals, so the default deployment is unchanged

> Client bundles only get build-time `NEXT_PUBLIC_*` + typed defaults; the live
> git-backed identity reaches the browser via the existing `/api/config/platform`
> fetch. `getPlatformIdentity()` is server-only.

## `identity:` keys → default → env override

| `identity.<key>` | Typed default | Env override |
|---|---|---|
| `baseDomain` | `example.com` | `NEXT_PUBLIC_BASE_DOMAIN` / `BASE_DOMAIN` |
| `brandName` | `InfraWeaver` | `PLATFORM_BRAND_NAME` |
| `registryHost` | `registry.int.<baseDomain>` | `REGISTRY_HOST` |
| `argocdUrl` | `https://argocd.int.<baseDomain>` | `ARGOCD_URL` |
| `authentikUrl` | `http://authentik-server.authentik.svc.cluster.local` | `AUTHENTIK_URL` |
| `authentikIssuer` | `https://auth.<baseDomain>/application/o/infraweaver-console/` | `AUTHENTIK_ISSUER` |
| `defaultCluster` | `homelab-prod` | `DEFAULT_CLUSTER_ID` |
| `tlsSecrets.{public,internal}` | `platform-wildcard-tls` / `platform-wildcard-int-tls` | — |
| `accessTierMiddlewares.{vpn,internal}` | `vpn-only` / `internal-only` | — |
| `internalHostAllowlist[]` | cluster svc hosts + NAS IPs (see platform-config) | — |
| `externalRouteDomains[]` | `[]` | — |
| `homepageServiceMap{}` | built-in label→app map | — |

`internalHostAllowlist`, `externalRouteDomains`, and `homepageServiceMap` are
**additive** — git entries extend the built-in defaults (so NAS/service hosts are
never dropped). The other keys replace per-field.

## What a fork sets

1. Fill `.env` (gitignored): `BASE_DOMAIN`, `PLATFORM_BRAND_NAME`, `DEFAULT_CLUSTER_ID`,
   `GITHUB_REPO`, etc. `scripts/generate-from-env.sh` substitutes the `${...}` tokens
   in `platform.yaml` + `kubernetes/` before bootstrap.
2. `NEXT_PUBLIC_BASE_DOMAIN` and friends are already wired into the console
   `kubernetes/catalog/infraweaver-console/base/deployment.yaml` env (which uses the
   same `${BASE_DOMAIN}`/`${GITHUB_REPO}` substitution).
3. ArgoCD reconciles `platform.yaml`; the console reads it live via `getPlatformIdentity()`.

## Verification (all passing)

- `npx tsc --noEmit` → 0 errors
- `npm run build` (`next build --webpack`) → success
- `InfraWeaver-infra/scripts/validate-platform-yaml.sh` → identity validation passed
- `InfraWeaver-infra/scripts/validate-iac.sh` → IaC validation PASSED

## Tracked follow-up (out of this scope)

- Migrate the remaining `withAuth`-eligible routes (~196) family-by-family.
- Repoint the other `ARGOCD_URL`-deriving routes (`argocd/sync`, `diff`, `rollback`,
  `events`, `hard-refresh`, `sync-all`, …) through `argocdApiBase()` / a shared
  `argocdFetch()` helper.
- Optionally derive `internalHostAllowlist` NAS hosts from `platform.yaml`'s
  `nas_providers` block instead of code defaults.
