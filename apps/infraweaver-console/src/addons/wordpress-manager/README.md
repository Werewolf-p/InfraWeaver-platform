# WordPress Manager addon

Provision secure WordPress sites from a name. The addon generates every secret,
brings up WordPress and its own MariaDB with hardened pods, wires DNS and a Traefik
IngressRoute, and offers a plugin manager with one-click Authentik SSO. All addon
logic lives under `src/addons/wordpress-manager/`; see `docs/design/wordpress-manager.md`
for the full design.

## Layout

    lib/
      naming.ts          site-name validation + per-site resource names
      secrets.ts         crypto-random password/salt generation, vault path map
      manifest.ts        pure k8s object builders (DB, WordPress, Service, IngressRoute)
      plugins.ts         plugin catalog + wp-cli command + sync-plan builders
      authentik.ts       WordPress OIDC plugin config builders (uses @/lib/sso)
      openbao.ts         minimal OpenBao/Vault KV v2 client
      k8s-exec.ts        exec into the WordPress pod (wp-cli)
      provision.ts       orchestration: create/list/delete sites, plugins, SSO
      wordpress-rbac.ts  addon-local permission types + scope + adapter
    api/handlers.ts      auth + RBAC + validation, delegated from the app router
    components/          WordpressDashboard + SiteDetailView (UI)
    pages/               P2 page-loader stubs

The Next route files under `src/app/api/wordpress/**` and the pages under
`src/app/(dashboard)/wordpress/**` are thin delegators that import from here, so the
real logic stays in the addon.

## Permissions

`wordpress:read`, `wordpress:write`, `wordpress:admin` are first-class members of
core's `Permission` union (mirroring how `game-hub:*` works), so per-site scoped
grants resolve through the same engine as every other permission. Three built-in
roles carry them — assign these through the console access UI:

| Role | Permissions | Use |
|---|---|---|
| `wordpress-viewer` | `wordpress:read` | read-only |
| `wordpress-editor` | `wordpress:read`, `wordpress:write` | create sites, manage plugins/SSO |
| `wordpress-admin` | + `wordpress:admin` | full control incl. delete |

`platform-admin` and the owner (`*`) always pass without an explicit grant.
Assign at scope `/wordpress/` (all sites) or `/wordpress/sites/<name>` (one site).
Read needs `wordpress:read`; create needs `wordpress:write`; delete needs
`wordpress:admin`. Expired grants are ignored everywhere, including site listing.

## Configuration (environment)

| Variable | Purpose | Default |
|---|---|---|
| `OPENBAO_ADDR` / `VAULT_ADDR` | Vault address | — (required for provisioning) |
| `OPENBAO_TOKEN` / `VAULT_TOKEN` | Vault token | — (required) |
| `WORDPRESS_VAULT_MOUNT` | KV v2 mount | `secret` |
| `WORDPRESS_BASE_DOMAIN` / `BASE_DOMAIN` | Site subdomain suffix | `int` |
| `WORDPRESS_INGRESS_IP` / `TRAEFIK_LB_IP` | A-record target | — (DNS skipped if unset) |
| `WORDPRESS_STORAGE_CLASS` | PVC storage class | `local-path-retain` |
| `WORDPRESS_IMAGE` / `WORDPRESS_DB_IMAGE` | Container images | `wordpress:6-php8.3-apache` / `mariadb:11` |
| `WORDPRESS_CERT_ISSUER` | Traefik certResolver for site TLS | — (Traefik default/wildcard) |
| `WORDPRESS_VAULT_TIMEOUT_MS` | Vault request timeout | `10000` |
| `AUTHENTIK_NAMESPACE` | Where blueprint ConfigMaps are written | `authentik` |
| `WORDPRESS_METRICS_TOKEN` | Bearer token gating `GET /api/wordpress/metrics` (Prometheus scrape) | — (endpoint fails closed if unset) |

DNS uses the console's existing Cloudflare helper (`CF_ZONE_ID` etc. already set
for the platform).

## Connector telemetry (Prometheus)

`GET /api/wordpress/metrics` exports the IWSL Connector fleet as Prometheus text
(`iwsl_connector_*` gauges: `up`, roundtrip, key epochs, `last_seq`, nonce-cache
size, rotation-pending, last-reroll, `_info`). Every value is sourced from a
signed `metrics.snapshot` command over the SAME dual-signed, pinned-key-verified
channel as `health.check` — a tampered reply quarantines the link and never
reaches a gauge, so the exporter is authenticated end-to-end and the scrape
surface is the only new thing exposed. It is gated two ways: an `Authorization:
Bearer <WORDPRESS_METRICS_TOKEN>` header (how the `ServiceMonitor` scrapes) or an
operator session with `wordpress:read`. Per-link readings are SWR-cached so a 60s
scrape does not block on a fresh ~seconds-long signed round-trip per site. Apply
`k8s/metrics-servicemonitor.yaml` (see its notes) to wire Prometheus;
`deploy.sh` provisions the token Secret from OpenBao (`SKIP_METRICS=1` to skip).

## Security notes (reviewed during build)

- Site names and plugin slugs are regex-validated; `wp-cli` slug builders throw on
  anything outside `[a-z0-9-]`, so there is no shell-injection surface.
- The OIDC `client_secret` is piped to `wp option update` over **stdin**, never as
  a command argument, so it doesn't land in the Kubernetes exec audit log. The
  issuer must be an `https` URL (enforced both client- and server-side).
- Secrets are written to the vault and projected as Kubernetes Secret references;
  they are never logged, embedded in a manifest, or returned over the API. Vault
  reuse is idempotent — re-provisioning never re-keys a live site's DB.
- Pods run non-root with `allowPrivilegeEscalation: false`, all capabilities
  dropped, `seccompProfile: RuntimeDefault`, CPU/memory requests + memory limits,
  and liveness probes. A NetworkPolicy restricts each MariaDB to only its own
  WordPress pods. The DB readiness/liveness probe passes the root password via
  `MYSQL_PWD` (env), not on the command line.
- Mutation endpoints are per-user rate-limited; API errors are logged server-side
  and returned to callers as generic messages so internal topology isn't disclosed.

## What is verified vs. what needs a cluster

`tests/unit/wordpress-manager/core.test.ts` proves the pure core (manifests,
secrets, plugin diffs, Authentik blueprints, RBAC scoping, k8s error handling,
typed errors) — 50 tests, green. The
orchestration in `provision.ts` and the deploy below talk to a live cluster,
OpenBao, Cloudflare, and Authentik and must be verified there; they are typed and
reviewed but not exercised from the build environment.

## Going live

The addon is `defaultEnabled: false`. Enable it per the platform's addon settings,
apply `k8s/namespace.yaml`, set the environment above, then ship the console image
the usual way (`docker build` → Zot → `kubectl set image`). `deploy.sh` documents
the exact sequence; run it from the console app root once the env is in place.
