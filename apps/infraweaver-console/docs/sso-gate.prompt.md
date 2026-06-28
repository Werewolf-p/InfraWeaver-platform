# Build a reusable "Authentik SSO in front of any site" capability

> Cold-start engineering brief. Execute in phases: **Research → Plan → Develop → Test → Deploy → Verify.**
> Repo: `/home/runner/InfraWeaver-platform/apps/infraweaver-console` (Next.js 16 + TS + jest).
> Read `AGENTS.md` first — this Next.js has breaking changes; check `node_modules/next/dist/docs/` before touching routes.

## Mission

One reusable server-side capability — `ensureSsoGate()` — that can place Authentik SSO **in front of any website/service** the platform manages, with **no per-site manual steps**. It must serve every current and future consumer:

- **Edge gate** (works for ANY site, zero app changes): Authentik **Proxy Provider** (forward/transparent auth) + Application, attached to the **embedded outpost**, with the Traefik `forward-auth` middleware on the route. Anyone hitting the host must authenticate at Authentik first.
- **App OIDC** (for apps with their own login, e.g. WordPress auto-login): an **OAuth2/OpenID Provider** + Application; returns client credentials the app configures.
- **Both**: edge gate + OIDC.

The WordPress Manager addon is the **first consumer** (replacing its broken per-site blueprint approach); external-routes and future addons reuse the same function.

## Context & verified findings (do NOT re-derive)

- **Authentik does not auto-discover blueprint ConfigMaps here.** Live blueprints are FILES volume-mounted into `authentik-worker` at `/blueprints/mounted/...` (label `goauthentik.io/blueprint:"true"`). So dynamic, per-site provisioning **must use the Authentik REST API**, not blueprints.
- **Forward-auth requires the host on a Proxy Provider attached to an outpost.** Known prior bug: embedded outpost shipped with `providers:[]` / empty host → 404s. So the gate flow MUST add each new proxy provider to the **embedded outpost** (`PATCH /api/v3/outposts/instances/<embedded-pk>/`, append provider pk) or forward-auth won't protect the host.
- Available env on the console: `AUTHENTIK_URL=http://authentik-server.authentik.svc.cluster.local`, `AUTHENTIK_TOKEN` (secret `infraweaver-console-secret` key `authentik-token`), and per-consumer a public issuer (`WORDPRESS_AUTHENTIK_ISSUER=https://auth.rlservers.com`). Generalize: read `AUTHENTIK_PUBLIC_URL`/`AUTHENTIK_ISSUER_BASE` with sensible fallback.
- Traefik middlewares live in the **`traefik`** namespace: `forward-auth`, `forward-auth-admin`, `secure-headers` (NOT kube-system — the WP manifest was already corrected to read these from env: `WORDPRESS_FORWARD_AUTH_MIDDLEWARE` default `traefik/forward-auth`).
- Secrets store: OpenBao via the addon's `lib/openbao.ts` (KV v2, mount `secret`). WordPress uses `secret/wordpress/<id>/{authentik,config}`. Generalize the SSO module to take a caller-supplied vault path so any consumer can persist its client secret.
- Console SA RBAC already covers what's needed (HTTP to Authentik needs only the token; Traefik `ingressroutes`+`middlewares` already granted in the `wordpress` ns).

## Phase 1 — Research (before writing code)

1. Inspect the **real** Authentik API shapes on THIS instance (versions differ — copy the live shape, don't guess):
   - `GET /api/v3/providers/proxy/` and `/api/v3/providers/oauth2/` (note required fields: `authorization_flow`, `invalidation_flow`, `mode`, `external_host`, `signing_key`, `property_mappings`).
   - `GET /api/v3/flows/instances/?slug=default-provider-authorization-explicit-consent` and `...invalidation-flow` → flow pks.
   - `GET /api/v3/crypto/certificatekeypairs/?name=authentik%20Self-signed%20Certificate` → signing key pk.
   - `GET /api/v3/outposts/instances/` → the **embedded** outpost pk + current `providers`.
   - `GET /api/v3/propertymappings/provider/scope/?managed__isnull=false` → openid/email/profile pks.
   - Cross-check against a working example: `kubectl -n authentik get cm authentik-blueprint-forward-auth -o yaml` (a real proxy provider) and `authentik-blueprint-apps`.
   Call the API with: `TOKEN=$(kubectl -n infraweaver-console get secret infraweaver-console-secret -o jsonpath='{.data.authentik-token}'|base64 -d)` against the in-cluster URL via a debug pod or `kubectl exec`.
2. Confirm the WordPress consumer's current SSO code paths to replace: `src/addons/wordpress-manager/lib/{authentik.ts,authentik-apply.ts,provision.ts}` (`enableSso`, `buildSsoEnablePlan`, the `applyBlueprint` hook), and the fragile `scheduleFinalize` finalizer.

## Phase 2 — Plan

- New shared module `src/lib/sso/authentik-client.ts` (typed v3 client) + `src/lib/sso/sso-gate.ts` exposing:
  ```ts
  type GateMode = "gate" | "oidc" | "both";
  interface SsoGateInput { host: string; appSlug: string; appName: string; mode: GateMode;
    redirectUris?: string[]; launchUrl?: string; }
  interface SsoGateResult { oidc?: { issuer: string; clientId: string; clientSecret: string;
    authorizeUrl: string; tokenUrl: string; userinfoUrl: string; endSessionUrl: string };
    gated: boolean; }
  ensureSsoGate(input, secretStore): Promise<SsoGateResult>   // idempotent
  removeSsoGate(appSlug, host): Promise<void>                 // teardown
  ```
  - `secretStore` is a small interface `{ read(path), write(path,data) }` so the caller (WordPress) plugs in `lib/openbao.ts`; the module never hardcodes a vault layout.
  - `mode:"gate"` → ensure Proxy Provider (`mode=forward_single`/`forward_domain` as appropriate, `external_host=https://<host>`) + Application + **append provider to embedded outpost**; caller attaches `forward-auth` middleware to the route.
  - `mode:"oidc"` → ensure OAuth2 provider + Application; mint/reuse client secret from `secretStore`; return endpoints + creds.
  - `mode:"both"` → both, sharing the Application.
- Integration: WordPress `enableSso` becomes a thin call to `ensureSsoGate({host, appSlug:"wordpress-"+id, mode: authMode==="full" ? "both":"oidc" /* gate handled by Traefik mw already in manifest */, redirectUris:[redirectUri(host)], launchUrl:`https://${host}/wp-admin/`})`, then configure the WP OIDC plugin (settings over STDIN, unchanged). `deleteSite` calls `removeSsoGate`.
- Reliability: replace `scheduleFinalize` with **poll-driven reconcile** — `listSites()` calls a deduped `triggerReconcile(site)` for every READY site; `reconcileSite` is idempotent, gated by a module `settled` set + the vault `applied` flag. Converges on any replica, survives restarts. (See sibling brief if present.)

## Phase 3 — Develop (requirements)

- **Idempotent**: match providers by `name`, applications by `slug`, outpost membership by pk-set union. PATCH when present, POST when absent. Never rotate an existing client secret; mint only when missing.
- **Secure**:
  - `client_type:"confidential"`; client secret 48+ chars from CSPRNG; stored only via `secretStore` and (for OIDC apps) pushed to the app over STDIN — never on a CLI, never logged, never returned to a browser client.
  - `redirect_uris` EXACT per host, no wildcards. `external_host` exact `https://<host>`.
  - Authentik token read from env, asserted present, never logged; bounded `fetch` timeout + `AbortController`; on network failure throw a retryable 503-style typed error.
  - No secrets or internal topology in any error surfaced to an HTTP caller.
- **Least surprise**: `removeSsoGate` deletes the Application + Provider and removes the provider pk from the embedded outpost (so stale hosts don't accumulate).
- Keep functions <50 lines, many small files, explicit types on exports (house style in `~/.claude/rules`).

## Phase 4 — Test

- `tests/unit/.../sso-gate.test.ts` with mocked `fetch`: provider create-vs-patch idempotency; exact redirect/external host; secret never appears in any serialized payload that gets logged; outpost membership is a union (no dupes); teardown deletes + de-registers. Update WordPress tests to the new `enableSso` shape.
- Green gate: `npx tsc --noEmit && npx eslint src && npx jest tests/unit/wordpress-manager tests/unit/**/sso-gate*` (keep ≥ current passing count).

## Phase 5 — Build & Deploy (exact — gotchas baked in)

```bash
TAG=sso-gate-$(date +%Y%m%d-%H%M%S)
cd apps/infraweaver-console
NODE_OPTIONS=--max-old-space-size=2560 NEXT_PUBLIC_APP_VERSION=$TAG npm run build   # 3.8GB host: cap mem or OOM
# buildctl→Zot returns 415; use the LEGACY docker builder (schema2 manifest Zot accepts):
DOCKER_BUILDKIT=0 docker build -f Dockerfile.prebuilt --build-arg APP_VERSION=$TAG \
  -t registry.int.rlservers.com/infraweaver-console:$TAG . && \
docker push registry.int.rlservers.com/infraweaver-console:$TAG
# Bump BOTH image lines (initContainer + console) in InfraWeaver-infra
#   kubernetes/catalog/infraweaver-console/overlays/prod/kustomization.yaml → $TAG
# commit + push origin/main (private repo push is allowed; the pre-push guard only blocks the public IAC mirror)
kubectl -n argocd annotate applications.argoproj.io catalog-infraweaver-console-manifests \
  argocd.argoproj.io/refresh=hard --overwrite     # app has selfHeal=true
kubectl -n infraweaver-console rollout status deploy/infraweaver-console
```

## Phase 6 — Verify (done criteria)

- For `testsite` (authMode=full) the dashboard poll reconciles it: vault `secret/wordpress/testsite/authentik` exists, `config.applied=true`, and `GET /api/v3/core/applications/?slug=wordpress-testsite` returns 1; the embedded outpost lists the proxy provider; visiting `/wp-admin` redirects through Authentik and auto-signs in (no "not found").
- Create a NEW site with authMode `admin`: public pages load, `/wp-admin` gates through Authentik, `/xmlrpc.php` → 403, `/wp-json/wp/v2/users` blocked.
- Prove reuse: a second consumer (e.g. an external route) can call `ensureSsoGate({host, appSlug, mode:"gate"})` and the host becomes Authentik-protected with no manual Authentik clicks.
- Update memory `project_wordpress_manager_domains_authmodes_2026-06-28.md` (and add a `project_sso_gate_*` note) with the API approach + new image tag.

## Guardrails

- Cost-aware: implement the coupled backend yourself; use a subagent only for the test file or a second consumer. Don't loop the full site-creation flow more than needed.
- Don't reintroduce blueprint ConfigMaps — they are not discovered on this cluster.
- Keep it generic: nothing WordPress-specific inside `src/lib/sso/*`.
