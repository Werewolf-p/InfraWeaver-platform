# Security assessment — 2026-05

## Scope
`apps/infraweaver-console` API and game-hub/RBAC paths.

## Findings addressed
- **Unauthenticated catalog installs**: `/api/catalog-install` now requires a session, `catalog:write`, rate limits, and sanitized errors.
- **Homepage SSRF**: `/api/homepage-ping` now allowlists domains, blocks localhost/raw IPs, and returns blocked results per URL.
- **Global TLS bypass in NAS routes**: replaced `NODE_TLS_REJECT_UNAUTHORIZED=0` usage with scoped `undici` agent helper.
- **NAS YAML injection risk**: share assignment inputs now validate against safe-name rules before YAML writes.
- **Sensitive error leakage**: added `safeError()` and used it on high-risk routes.
- **Unsafe unseal success path**: `/api/security/unseal` now returns actual failures instead of simulated success.
- **Missing mutation throttling**: cluster drain/cordon/scale/rolling-restart routes now enforce route-level rate limits.
- **Weak logs authorization**: log routes now validate namespace/pod/container names and enforce scoped game-hub access.
- **Game-hub privilege gaps**: game-hub read/write/admin operations now use scoped RBAC checks tied to `users.yaml` role assignments.

## RBAC changes
- Introduced a compatibility-focused RBAC v2 model in `src/lib/rbac.ts`.
- Added built-in roles for platform and game server administration/operator/viewer access.
- Preserved compatibility with legacy role IDs through aliases.
- Added public role discovery and per-user assignment APIs backed by `users.yaml`.

## Remaining risks / follow-up
- Existing audit logging still writes to `/tmp/infraweaver-audit.log`; move this to a repository-managed or persistent path.
- Verify all UI consumers are updated for the new egg schema and scoped RBAC flows.
- Consider centralizing route-level authorization helpers to reduce drift across future API additions.
- Review whether game-hub should eventually use per-server namespaces instead of single-namespace scoped matching.

## Files of interest
- `apps/infraweaver-console/src/lib/rbac.ts`
- `apps/infraweaver-console/src/lib/game-hub.ts`
- `apps/infraweaver-console/src/lib/users-config.ts`
- `apps/infraweaver-console/src/lib/insecure-fetch.ts`
- `apps/infraweaver-console/src/app/api/homepage-ping/route.ts`
- `apps/infraweaver-console/src/app/api/catalog-install/route.ts`
- `apps/infraweaver-console/src/app/api/logs/**`
- `apps/infraweaver-console/src/app/api/game-hub/**`

## Additional API hardening — 2026-05 follow-up
- Added a middleware-level authenticated mutation throttle so POST/PUT/PATCH/DELETE API calls now have a default per-route rate limit even when handlers forgot endpoint-specific throttles.
- Reworked NAS API access to require `nas:read`/`nas:write` instead of broad `users:*` permissions, added route throttles, and constrained NAS HTTP calls to allowlisted internal hosts only.
- Introduced pinned outbound HTTPS validation helpers for user-supplied webhook/plugin URLs; unsafe/private/internal destinations are rejected and outbound requests now resolve-and-connect using the validated IP.
- Hardened game-hub webhook sending and plugin installation so they no longer execute arbitrary pod-side downloads or server-side webhook probes against internal targets.
- Tightened ArgoCD diff access back to operator-level (`apps:sync`) and added missing route-specific throttles plus Kubernetes name validation on rollback, hard-refresh, uninstall, HPA, PVC cleanup, restart-app, migrate-pod, scale, and test-alert flows.
