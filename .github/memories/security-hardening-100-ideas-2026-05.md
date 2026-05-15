# Security Hardening — 100 Application Ideas (2026-05)

Generated after reviewing the InfraWeaver console codebase, security memories, auth flow, security routes, RBAC helpers, and related Kubernetes manifests.

Legend: implemented = completed in this branch, planned = reviewed and scoped but not yet implemented.

## 1. Enforce security:read on all security dashboards
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/security/posture/route.ts; apps/infraweaver-console/src/app/api/security/enhanced/route.ts; apps/infraweaver-console/src/app/api/security/kyverno/route.ts; apps/infraweaver-console/src/app/api/security/rbac/route.ts; apps/infraweaver-console/src/app/api/security/images/route.ts; apps/infraweaver-console/src/app/api/security/secrets/route.ts; apps/infraweaver-console/src/app/api/security/auth-events/route.ts; apps/infraweaver-console/src/app/api/security/audit-log/route.ts
- Plan: Replace group-only gate checks with session-aware requireRoutePermissions so direct API callers need security:read and inherited role assignments work consistently.
- Bypass / defense in depth: This closes a bypass where config:read users could reach security routes and removes drift between UI hiding and server enforcement.
- Monitoring / verification: Track 403 counts on /api/security/* and review denied principals after RBAC changes.

## 2. Require security:write plus schema validation on audit log writes
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/security/audit-log/route.ts
- Plan: Gate POST with security:write, validate action/resource/details/result with zod, and refuse spoofed user and ip fields from clients.
- Bypass / defense in depth: This prevents low-privilege users from planting fake audit records and blocks malformed entries from poisoning the store.
- Monitoring / verification: Alert on repeated 400 and 403 responses for POST /api/security/audit-log.

## 3. Remove fake auth-event fallback data
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/security/auth-events/route.ts
- Plan: Return authoritative Authentik events or an empty unavailable state instead of invented sample logins.
- Bypass / defense in depth: This avoids a false sense of safety and makes outages obvious instead of silently replacing production telemetry with mock activity.
- Monitoring / verification: Alert when auth-events source stays unavailable for longer than one scrape interval.

## 4. Add mutation request body limits in middleware
- Status: implemented
- Files: apps/infraweaver-console/src/lib/api-helpers.ts; apps/infraweaver-console/src/middleware.ts
- Plan: Reject oversized POST, PUT, PATCH, and DELETE requests before parsing based on route-specific content-length ceilings for common large editors and uploads.
- Bypass / defense in depth: This reduces memory pressure and request-smuggling style abuse while keeping trusted large editors functional through explicit overrides.
- Monitoring / verification: Export body-limit rejection counts to logs and graph by route prefix.

## 5. Redact tokens and secrets from audit details
- Status: implemented
- Files: apps/infraweaver-console/src/lib/audit-log.ts
- Plan: Sanitize audit detail strings for bearer tokens, passwords, JWTs, and JSON secret fields before storage or stdout logging.
- Bypass / defense in depth: This keeps the audit trail usable without turning it into another secret store attackers can mine after read access.
- Monitoring / verification: Run periodic searches over audit output for suspicious unredacted patterns.

## 6. Sanitize Authentik session responses
- Status: implemented
- Files: apps/infraweaver-console/src/lib/authentik.ts; apps/infraweaver-console/src/app/api/profile/sessions/route.ts; apps/infraweaver-console/src/app/api/users/[username]/sessions/route.ts
- Plan: Map Authentik token objects to a small allowlisted session summary containing only identifier, timestamps, and description.
- Bypass / defense in depth: This removes accidental leakage of token metadata and future Authentik fields the UI does not need.
- Monitoring / verification: Add unit tests that fail if additional fields start leaking into session responses.

## 7. Verify session ownership before revocation
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/users/[username]/sessions/[tokenId]/route.ts
- Plan: Load the target user’s Authentik sessions and revoke only when the requested token identifier belongs to that user.
- Bypass / defense in depth: This blocks crafted URL paths from revoking arbitrary Authentik sessions when an operator guesses or obtains another token id.
- Monitoring / verification: Log every failed revoke attempt with username and token id prefix and review for enumeration attempts.

## 8. Validate and rate-limit profile email changes
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/profile/email/route.ts
- Plan: Use zod validation plus a tight per-user rate limit before patching Authentik email data for the logged-in user.
- Bypass / defense in depth: This slows account-takeover probing and blocks malformed payloads from reaching the identity provider.
- Monitoring / verification: Alert on multiple email change attempts from the same IP or session in a short window.

## 9. Validate and rate-limit profile display-name changes
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/profile/name/route.ts
- Plan: Require a trimmed bounded display name and rate-limit repeated PATCH attempts before updating Authentik.
- Bypass / defense in depth: This reduces abuse of profile updates for flooding or injection payload testing.
- Monitoring / verification: Watch for bursty profile name updates that may indicate scripted abuse.

## 10. Audit self-service profile changes
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/profile/email/route.ts; apps/infraweaver-console/src/app/api/profile/name/route.ts
- Plan: Write audit entries for successful self-service email and name changes with request metadata attached.
- Bypass / defense in depth: This adds accountability for low-risk changes that often precede social engineering or recovery abuse.
- Monitoring / verification: Surface profile change events in the security dashboard and alert on rapid churn.

## 11. Use a host-only strict session cookie
- Status: implemented
- Files: apps/infraweaver-console/src/lib/auth.ts
- Plan: Prefix the session cookie with __Host- when secure and tighten SameSite to Strict while leaving OIDC transient cookies compatible with redirects.
- Bypass / defense in depth: This reduces cross-site cookie replay and subdomain confusion without breaking the Authentik login flow.
- Monitoring / verification: Monitor login success and callback failures immediately after deployment to catch cookie regressions.

## 12. Add Authentik fetch timeout and no-store semantics
- Status: implemented
- Files: apps/infraweaver-console/src/lib/authentik.ts
- Plan: Wrap Authentik API calls with a short timeout, no-store cache mode, and redirect:error to avoid hanging or caching identity traffic.
- Bypass / defense in depth: This cuts availability risk from slow upstreams and reduces the chance of stale identity data driving authorization decisions.
- Monitoring / verification: Track Authentik timeout rates separately from application errors.

## 13. Capture request user-agent on manual audit entries
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/security/audit-log/route.ts
- Plan: Store user-agent alongside IP for manually recorded audit entries so investigators can distinguish browser, automation, and curl activity.
- Bypass / defense in depth: This raises the cost of spoofing because an attacker has to mimic more context and gives responders better triage clues.
- Monitoring / verification: Add dashboard filters for user-agent families and unusual clients.

## 14. Cap and validate audit entry size
- Status: implemented
- Files: apps/infraweaver-console/src/app/api/security/audit-log/route.ts
- Plan: Reject giant action, resource, and details fields with zod limits before persisting to the ConfigMap-backed log.
- Bypass / defense in depth: This prevents log-stuffing attacks that could evict useful history or blow ConfigMap size limits.
- Monitoring / verification: Alert when requests hit the audit entry size ceiling because legitimate callers should rarely do so.

## 15. Replace remaining group-only permission checks in security routes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/security/*.ts; apps/infraweaver-console/src/lib/rbac.ts; apps/infraweaver-console/src/lib/session-rbac.ts
- Plan: Sweep every security route that still evaluates only session groups and convert them to session RBAC context with scoped role assignments.
- Bypass / defense in depth: This closes gaps where delegated roles work in the UI but are ignored or bypassed on the server.
- Monitoring / verification: Add a CI check that fails on hasPermission(groups without role assignments inside app/api/security.

## 16. Migrate registry, NetBird, topology, and config routes to session RBAC
- Status: planned
- Files: apps/infraweaver-console/src/app/api/registry/**; apps/infraweaver-console/src/app/api/netbird/peers/route.ts; apps/infraweaver-console/src/app/api/network/topology/route.ts; apps/infraweaver-console/src/app/api/config/**
- Plan: Standardize these routes on requireRoutePermissions so role assignments and legacy groups resolve through one path.
- Bypass / defense in depth: This reduces authorization drift and prevents a future role-assignment feature from silently leaving back-end routes under-protected.
- Monitoring / verification: Log mismatches between UI-visible permissions and server-denied routes during the migration period.

## 17. Create a single audited requirePermission wrapper
- Status: planned
- Files: apps/infraweaver-console/src/lib/route-utils.ts; apps/infraweaver-console/src/lib/audit-log.ts
- Plan: Add a helper that both checks permissions and records denied access with route, actor, and source metadata so new routes inherit good defaults.
- Bypass / defense in depth: This avoids copy-paste authorization code that forgets audit logging or caches permissions too aggressively.
- Monitoring / verification: Publish a metric for deny counts by permission name and route.

## 18. Ban raw request.json usage in API routes
- Status: planned
- Files: apps/infraweaver-console/src/lib/route-utils.ts; apps/infraweaver-console/src/app/api/**
- Plan: Build a parseJsonBodyWithSchema helper that enforces size, content type, and zod validation, then migrate every direct req.json call to it.
- Bypass / defense in depth: This eliminates inconsistent validation paths and closes easy omissions when new routes are added.
- Monitoring / verification: Fail CI if grep finds request.json outside the approved helper or explicit multipart handlers.

## 19. Enforce content-type allowlists on mutations
- Status: planned
- Files: apps/infraweaver-console/src/middleware.ts; apps/infraweaver-console/src/app/api/**
- Plan: Reject state-changing requests that are not application/json or approved multipart forms for upload endpoints.
- Bypass / defense in depth: This makes CSRF and parser-confusion attacks harder because browsers cannot smuggle form posts into JSON-only handlers.
- Monitoring / verification: Chart 415 responses by route to spot broken clients during rollout.

## 20. Add Fetch Metadata checks to mutations
- Status: planned
- Files: apps/infraweaver-console/src/middleware.ts
- Plan: Use sec-fetch-site and sec-fetch-mode as a second CSRF signal alongside Origin and Referer checks for browser requests.
- Bypass / defense in depth: This protects against edge cases where Origin is missing and gives defense in depth against cross-site navigation tricks.
- Monitoring / verification: Log every fetch-metadata rejection with headers so false positives can be tuned quickly.

## 21. Require idempotency keys on destructive operations
- Status: planned
- Files: apps/infraweaver-console/src/app/api/apps/[name]/uninstall/route.ts; apps/infraweaver-console/src/app/api/cluster/drain/route.ts; apps/infraweaver-console/src/app/api/cluster/namespace-cleanup/route.ts; apps/infraweaver-console/src/app/api/community-apps/deploy/route.ts
- Plan: Store short-lived idempotency keys per user and route so repeated clicks or retries do not double-delete or double-drain resources.
- Bypass / defense in depth: This prevents replay and accidental duplicate mutations that are otherwise easy to trigger from flaky UIs or repeated browser submits.
- Monitoring / verification: Alert when a client repeatedly reuses keys outside the normal retry window.

## 22. Rate-limit expensive read endpoints by identity
- Status: planned
- Files: apps/infraweaver-console/src/app/api/logs/**; apps/infraweaver-console/src/app/api/metrics/**; apps/infraweaver-console/src/app/api/security/**
- Plan: Add per-user and per-IP ceilings to high-cost GET routes so authenticated scraping cannot starve the console or kube-apiserver.
- Bypass / defense in depth: This reduces low-noise enumeration from compromised read-only accounts that currently bypass mutation-only throttles.
- Monitoring / verification: Expose read-throttle metrics by permission tier.

## 23. Add response size limits to logs and metrics
- Status: planned
- Files: apps/infraweaver-console/src/app/api/logs/stream/route.ts; apps/infraweaver-console/src/app/api/logs/[namespace]/[pod]/[container]/route.ts; apps/infraweaver-console/src/app/api/cluster/metrics/route.ts; apps/infraweaver-console/src/app/api/cluster/pod-metrics/route.ts
- Plan: Clip or paginate oversized responses so one request cannot return unbounded log or metrics blobs.
- Bypass / defense in depth: This limits data exfiltration and memory blowups while keeping the UI responsive under heavy clusters.
- Monitoring / verification: Track truncated responses and tune the limits with real usage.

## 24. Paginate audit, auth, and log views
- Status: planned
- Files: apps/infraweaver-console/src/app/api/security/audit-log/route.ts; apps/infraweaver-console/src/app/api/security/auth-events/route.ts; apps/infraweaver-console/src/app/api/logs/analytics/route.ts
- Plan: Replace fixed slices with cursor or page parameters plus hard maximums so the UI never loads entire histories at once.
- Bypass / defense in depth: This narrows scraping windows and keeps expensive queries bounded even if stores grow or backends change.
- Monitoring / verification: Measure average page depth and error rates for pagination tokens.

## 25. Centralize namespace allowlisting for Kubernetes mutations
- Status: planned
- Files: apps/infraweaver-console/src/lib/validate.ts; apps/infraweaver-console/src/app/api/cluster/**; apps/infraweaver-console/src/app/api/pods/**
- Plan: Add a shared policy helper that classifies namespaces into safe, protected, and forbidden sets for each action type before kubectl or client-node calls.
- Bypass / defense in depth: This prevents namespace escape when routes validate syntax but not business ownership, especially for kube-system and security namespaces.
- Monitoring / verification: Log all blocked attempts against protected namespaces and alert on repeated probes.
## 26. Deny destructive operations in system namespaces by default
- Status: planned
- Files: apps/infraweaver-console/src/app/api/cluster/restart-app/route.ts; apps/infraweaver-console/src/app/api/pods/restart/route.ts; apps/infraweaver-console/src/app/api/pods/[namespace]/[name]/route.ts
- Plan: Require a platform-owner override or explicit allowlist before delete, restart, drain, or force-sync actions can target control-plane namespaces.
- Bypass / defense in depth: This adds a blast-radius brake when a compromised admin account or buggy UI targets critical components.
- Monitoring / verification: Record every override use and review them in weekly ops meetings.

## 27. Scope platform editor and cluster settings writes more tightly
- Status: planned
- Files: apps/infraweaver-console/src/app/api/platform-editor/route.ts; apps/infraweaver-console/src/app/api/cluster/settings/route.ts; apps/infraweaver-console/src/app/api/config/platform/route.ts
- Plan: Split broad config:write into narrower permissions for read-only inspection, manifest edits, and commit or push operations.
- Bypass / defense in depth: This limits lateral movement when one credential only needs dashboards but currently inherits powerful write paths.
- Monitoring / verification: Track which fine-grained permission each write route consumes and audit unused grants quarterly.

## 28. Add self-service session revocation for the current user
- Status: planned
- Files: apps/infraweaver-console/src/app/api/profile/sessions/route.ts; apps/infraweaver-console/src/app/(dashboard)/profile/page.tsx
- Plan: Expose a profile-scoped DELETE path that lets users revoke their own Authentik sessions without full user-management privileges.
- Bypass / defense in depth: This reduces dwell time after device loss and avoids routing simple hygiene through high-privilege operators.
- Monitoring / verification: Alert when users mass-revoke sessions because it may indicate compromised credentials.

## 29. Revoke server-side sessions on logout
- Status: planned
- Files: apps/infraweaver-console/src/lib/auth.ts; apps/infraweaver-console/src/lib/authentik.ts; apps/infraweaver-console/src/app/api/auth/[...nextauth]/route.ts
- Plan: Call Authentik token revocation during signOut or logout webhooks so tokens are invalidated instead of merely removing the browser cookie.
- Bypass / defense in depth: This closes the gap where stolen upstream tokens survive after local logout.
- Monitoring / verification: Track revocation success and retry failure rates to avoid silent drift.

## 30. Shorten admin session lifetime and add inactivity timeout
- Status: planned
- Files: apps/infraweaver-console/src/lib/auth.ts; apps/infraweaver-console/src/app/(dashboard)/layout.tsx
- Plan: Use role-aware maxAge or a last-seen timestamp to expire cluster-admin and rbac-admin sessions faster than viewer sessions.
- Bypass / defense in depth: This reduces the value of stolen admin cookies while preserving reasonable UX for lower-risk read-only users.
- Monitoring / verification: Monitor reauthentication frequency and timeout-driven signouts by role.

## 31. Require sudo-mode reauthentication for dangerous actions
- Status: planned
- Files: apps/infraweaver-console/src/lib/auth.ts; apps/infraweaver-console/src/app/api/cluster/**; apps/infraweaver-console/src/app/api/users/**; apps/infraweaver-console/src/app/api/security/unseal/route.ts
- Plan: Introduce a short-lived step-up token that must be refreshed before cluster-admin, user-management, or unseal operations.
- Bypass / defense in depth: This contains session hijacks and shoulder-surfed sessions because privileged buttons stop working after a short window.
- Monitoring / verification: Log sudo-mode grants and expired-attempt failures separately from normal authorization denies.

## 32. Enforce MFA claims for sensitive routes
- Status: planned
- Files: apps/infraweaver-console/src/lib/auth.ts; apps/infraweaver-console/src/app/api/users/**; apps/infraweaver-console/src/app/api/rbac/**; apps/infraweaver-console/src/app/api/security/**
- Plan: Read MFA state from Authentik claims or a profile lookup and require it for users:write, rbac:admin, security:write, and cluster-admin flows.
- Bypass / defense in depth: This prevents single-factor OIDC sessions from making the highest-risk changes even if the base login succeeds.
- Monitoring / verification: Alert when privileged requests are denied for missing MFA so operators can see who still needs enrollment.

## 33. Limit concurrent sessions per user
- Status: planned
- Files: apps/infraweaver-console/src/lib/authentik.ts; apps/infraweaver-console/src/app/api/profile/sessions/route.ts; apps/infraweaver-console/src/app/api/users/[username]/sessions/route.ts
- Plan: Set a maximum active-session count and revoke oldest Authentik sessions when new ones exceed policy for sensitive roles.
- Bypass / defense in depth: This lowers the chance that long-forgotten browsers remain valid attack footholds.
- Monitoring / verification: Review users with frequent session churn for credential sharing or theft.

## 34. Apply admin IP allowlists to the most dangerous routes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/security/unseal/route.ts; apps/infraweaver-console/src/app/api/users/reset-password/route.ts; apps/infraweaver-console/src/app/api/rbac/assignments/route.ts
- Plan: Use a configurable allowlist of trusted VPN or office ranges before permitting unseal, password reset, and RBAC administration actions.
- Bypass / defense in depth: This creates a strong network boundary so a stolen admin session from an untrusted network cannot immediately perform the worst actions.
- Monitoring / verification: Page on any blocked privileged action from an off-list IP.

## 35. Detect session binding anomalies
- Status: planned
- Files: apps/infraweaver-console/src/lib/auth.ts; apps/infraweaver-console/src/app/api/auth/me/route.ts
- Plan: Record a coarse user-agent and IP fingerprint at sign-in and force reauth when a privileged session changes fingerprint drastically.
- Bypass / defense in depth: This is softer than hard binding and works better with mobile networks while still catching obvious cookie theft.
- Monitoring / verification: Log anomaly-triggered reauth events and correlate them with failed privileged requests.

## 36. Bypass RBAC cache for sensitive mutations
- Status: planned
- Files: apps/infraweaver-console/src/lib/session-rbac.ts; apps/infraweaver-console/src/app/api/users/**; apps/infraweaver-console/src/app/api/rbac/**; apps/infraweaver-console/src/app/api/security/**
- Plan: Use ttlSeconds 0 for the most sensitive routes so recently revoked roles stop working immediately instead of after the default cache window.
- Bypass / defense in depth: This prevents a short revocation race from becoming a real exploit path during incident response.
- Monitoring / verification: Measure cache-bypass latency and error rates to keep the higher freshness cost acceptable.

## 37. Audit authorization denials consistently
- Status: planned
- Files: apps/infraweaver-console/src/app/api/**; apps/infraweaver-console/src/lib/route-utils.ts
- Plan: Make every forbidden branch record an audit event with route, permission, scope, and request source so denied attempts are visible in one place.
- Bypass / defense in depth: This turns low-grade probing into observable behavior instead of silent 403 noise.
- Monitoring / verification: Create top-N dashboards for denied permissions and repeated offenders.

## 38. Record before-and-after diffs for RBAC changes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/rbac/assignments/route.ts; apps/infraweaver-console/src/app/api/users-config/[username]/rbac/route.ts
- Plan: Expand RBAC audit entries to include old assignment state, new state, and expiry changes rather than only free-form strings.
- Bypass / defense in depth: This makes role-escalation investigations possible and prevents ambiguous audit entries from hiding scope abuse.
- Monitoring / verification: Alert on wildcard or root-scope role grants immediately.

## 39. Validate commit metadata and changed paths in config editors
- Status: planned
- Files: apps/infraweaver-console/src/app/api/config/platform/route.ts; apps/infraweaver-console/src/app/api/users-config/route.ts; apps/infraweaver-console/src/app/api/platform-editor/route.ts
- Plan: Constrain commit messages, touched files, and branch targets with schemas so callers cannot smuggle unexpected file writes or confusing metadata.
- Bypass / defense in depth: This narrows abuse of config-writing endpoints and makes downstream git history more trustworthy.
- Monitoring / verification: Log rejected file-path and commit-message attempts with sanitized values.

## 40. Scrub secrets from platform-editor responses and previews
- Status: planned
- Files: apps/infraweaver-console/src/app/api/platform-editor/route.ts; apps/infraweaver-console/src/lib/utils.ts
- Plan: Redact token-like values, inline secrets, and secretRef payloads before returning diffs or previews from platform editing APIs.
- Bypass / defense in depth: This stops operators with partial access from discovering credentials in review screens or error previews.
- Monitoring / verification: Run automated redaction tests against representative manifest snippets.

## 41. Apply safeError to remaining profile and user routes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/profile/**; apps/infraweaver-console/src/app/api/users/**; apps/infraweaver-console/src/app/api/users-config/**
- Plan: Normalize all user-facing errors through safeError so upstream hostnames, paths, and stack details never leak in API responses.
- Bypass / defense in depth: This keeps exception details from becoming an internal map of services and file paths during probing.
- Monitoring / verification: Track how often errors are sanitized down to Internal error so observability still gets the full root cause elsewhere.

## 42. Harden rate limits on invite and password reset flows
- Status: planned
- Files: apps/infraweaver-console/src/app/api/users/invite/route.ts; apps/infraweaver-console/src/app/api/users/reset-password/route.ts
- Plan: Lower thresholds and add per-target-user cooling periods on invite and reset flows that can spam external identity systems.
- Bypass / defense in depth: This cuts brute-force, harassment, and resource exhaustion abuse on user-management endpoints.
- Monitoring / verification: Alert on repeated resets or invites for the same account and source IP.

## 43. Prevent self-lockout and self-offboard mistakes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/users/[username]/offboard/route.ts; apps/infraweaver-console/src/app/api/users/[username]/status/route.ts; apps/infraweaver-console/src/app/api/users-config/[username]/rbac/route.ts
- Plan: Block operators from disabling, offboarding, or removing the final admin role from their own active account without a second approver path.
- Bypass / defense in depth: This stops accidents and attacker attempts to sever recovery paths after session compromise.
- Monitoring / verification: Create alerts when a protected self-targeting action is blocked.

## 44. Whitelist mutable fields in users-config profile updates
- Status: planned
- Files: apps/infraweaver-console/src/app/api/users-config/[username]/route.ts
- Plan: Replace free-form Record updates with an explicit schema of writable fields and server-side transforms for arrays and role data.
- Bypass / defense in depth: This prevents mass-assignment bugs where a caller sets hidden properties that the UI never exposes.
- Monitoring / verification: Log unexpected field names as security events for future route reviews.

## 45. Validate identifiers across user-management routes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/users/**; apps/infraweaver-console/src/app/api/users-config/**
- Plan: Use shared zod schemas for usernames, emails, session ids, and invite groups so every route enforces the same syntax and length rules.
- Bypass / defense in depth: This removes subtle parser differences attackers can use to reach edge cases or alternate identities.
- Monitoring / verification: Add unit tests for every shared identifier schema and reuse them in route tests.

## 46. Verify target-user ownership before account operations
- Status: planned
- Files: apps/infraweaver-console/src/app/api/users/[username]/email/route.ts; apps/infraweaver-console/src/app/api/users/[username]/mfa/route.ts; apps/infraweaver-console/src/app/api/users/[username]/username/route.ts
- Plan: Fetch the target user first and confirm the downstream identity object matches the route username before mutating email, MFA, or username state.
- Bypass / defense in depth: This prevents crafted combinations of stale usernames and token ids from mutating the wrong identity record.
- Monitoring / verification: Log any mismatch between route username and returned identity object.

## 47. Add double-submit CSRF tokens for browser mutations
- Status: planned
- Files: apps/infraweaver-console/src/lib/auth.ts; apps/infraweaver-console/src/middleware.ts; apps/infraweaver-console/src/components/providers.tsx
- Plan: Issue a server cookie plus header token pair and require both on browser-based state changes in addition to same-origin checks.
- Bypass / defense in depth: This hardens against browsers that omit Origin and raises the bar if a same-site navigation bypass appears.
- Monitoring / verification: Monitor missing and mismatched CSRF tokens separately from origin failures.

## 48. Add anti-replay nonces for critical flows
- Status: planned
- Files: apps/infraweaver-console/src/app/api/apps/[name]/uninstall/route.ts; apps/infraweaver-console/src/app/api/cluster/drain/route.ts; apps/infraweaver-console/src/app/api/security/unseal/route.ts
- Plan: Issue one-time nonces for the most dangerous buttons so captured requests cannot simply be replayed by an attacker or browser extension.
- Bypass / defense in depth: This adds another brake beyond idempotency by proving the user saw the fresh confirmation step.
- Monitoring / verification: Track nonce issuance and reuse failures by route.

## 49. Persist audit logs in an authoritative backend
- Status: planned
- Files: apps/infraweaver-console/src/lib/audit-log.ts; apps/infraweaver-console/src/app/api/security/audit-log/route.ts; kubernetes/catalog/infraweaver-console/**
- Plan: Move from split stdout and ConfigMap logging to one server-only sink such as Loki, PostgreSQL, or a dedicated CRD with retention controls.
- Bypass / defense in depth: This prevents audit fragmentation and keeps the UI, alerts, and incident review reading the same truth source.
- Monitoring / verification: Alert when the audit backend falls behind or rejects writes.

## 50. Append audit entries from shared helpers automatically
- Status: planned
- Files: apps/infraweaver-console/src/lib/audit-log.ts; apps/infraweaver-console/src/app/api/**
- Plan: Create a server-only writer that all auditLog calls can use so every existing mutation route gains persistent records without extra per-route code.
- Bypass / defense in depth: This removes the current blind spot where many actions log to stdout but never appear in the dashboard.
- Monitoring / verification: Measure write latency and drop rate for background audit appends.
## 51. Escape exported CSV values to stop formula injection
- Status: planned
- Files: apps/infraweaver-console/src/components/security/audit-log-table.tsx; apps/infraweaver-console/src/components/users/sessions-panel.tsx
- Plan: Prefix dangerous cells that start with spreadsheet formula characters before export so downloading logs cannot trigger formulas in spreadsheet tools.
- Bypass / defense in depth: This blocks a classic exfiltration trick when attacker-controlled text lands in exported audit rows.
- Monitoring / verification: Add unit tests covering leading equals, plus, minus, and at-sign payloads.

## 52. Sanitize export filenames
- Status: planned
- Files: apps/infraweaver-console/src/components/security/audit-log-table.tsx
- Plan: Generate filenames from fixed prefixes and ISO dates only, never from user-provided route or filter strings.
- Bypass / defense in depth: This removes a low-level path and UI confusion vector when downloads are triggered from attacker-controlled contexts.
- Monitoring / verification: Track download events and periodically review filenames observed in telemetry.

## 53. Mask IPs in the security UI for non-admin readers
- Status: planned
- Files: apps/infraweaver-console/src/app/(dashboard)/security/page.tsx; apps/infraweaver-console/src/components/security/audit-log-table.tsx
- Plan: Render only coarse IP prefixes or VPN labels unless the viewer has a truly administrative permission.
- Bypass / defense in depth: This reduces operational data exposure if security:read is granted more broadly later.
- Monitoring / verification: Audit which roles access full IP detail and review quarterly.

## 54. Mask email addresses for lower-privilege user views
- Status: planned
- Files: apps/infraweaver-console/src/app/(dashboard)/users/page.tsx; apps/infraweaver-console/src/app/(dashboard)/profile/page.tsx
- Plan: Show abbreviated email addresses to read-only viewers and reveal full values only when users:write or higher is present.
- Bypass / defense in depth: This shrinks PII exposure while keeping the screens usable for most support workflows.
- Monitoring / verification: Log when full PII reveal actions occur and by whom.

## 55. Hide internal hostnames and private addresses from UI cards
- Status: planned
- Files: apps/infraweaver-console/src/app/(dashboard)/security/page.tsx; apps/infraweaver-console/src/app/(dashboard)/network/page.tsx; apps/infraweaver-console/src/lib/utils.ts
- Plan: Apply role-aware redaction to tables and badges that currently expose internal service names, cluster domains, and RFC1918 addresses.
- Bypass / defense in depth: This reduces reconnaissance value if a viewer account is compromised or screenshots leak.
- Monitoring / verification: Add snapshot tests for redacted and unredacted render states.

## 56. Audit localStorage usage and move risky state server-side
- Status: planned
- Files: apps/infraweaver-console/src/app/layout.tsx; apps/infraweaver-console/src/hooks/use-recent-searches.ts; apps/infraweaver-console/src/lib/user-preferences.ts
- Plan: Inventory everything stored in localStorage and move anything more sensitive than theme or non-security UX hints into the server-backed preference API.
- Bypass / defense in depth: This prevents future features from quietly persisting names, filters, or tokens into browser storage where XSS can read them.
- Monitoring / verification: Add a CI grep check for localStorage setItem calls outside an approved allowlist.

## 57. Avoid storing sensitive recent searches on the client
- Status: planned
- Files: apps/infraweaver-console/src/hooks/use-recent-searches.ts; apps/infraweaver-console/src/components/search/global-search.tsx
- Plan: Truncate, classify, or server-store recent searches so resource names and usernames are not preserved indefinitely on shared browsers.
- Bypass / defense in depth: This reduces shoulder-surfing and browser-profile leakage without removing the feature entirely.
- Monitoring / verification: Track how often search history is used before choosing the least disruptive retention model.

## 58. Redact request echoes in webhook tester
- Status: planned
- Files: apps/infraweaver-console/src/app/api/webhooks/test/route.ts
- Plan: Cap request and response bodies more tightly and redact secret-looking header values before returning the test result to the browser.
- Bypass / defense in depth: This keeps the diagnostic endpoint from becoming an easy place to reflect secrets back into the UI or logs.
- Monitoring / verification: Record when redaction fires so operators know why a test payload looked altered.

## 59. Require HMAC validation for any future inbound webhook routes
- Status: planned
- Files: apps/infraweaver-console/src/app/api/webhooks/**; docs/MIDDLEWARES.md
- Plan: Establish a shared verifier now so new inbound webhook endpoints do not launch without signatures, timestamp checks, and replay windows.
- Bypass / defense in depth: This prevents the common pattern where a route is added quickly and forgotten in a wide-open state.
- Monitoring / verification: Add integration tests with valid, invalid, and replayed signatures.

## 60. Enforce outbound destination allowlists per feature
- Status: planned
- Files: apps/infraweaver-console/src/lib/outbound-url.ts; apps/infraweaver-console/src/app/api/game-hub/servers/[name]/webhooks/route.ts; apps/infraweaver-console/src/app/api/webhooks/test/route.ts
- Plan: Move from generic safe external URLs to per-feature and per-server allowlists so only approved domains can receive sensitive outbound calls.
- Bypass / defense in depth: This limits data exfiltration if a privileged operator account is misused to add hostile webhooks.
- Monitoring / verification: Alert on blocked outbound destinations and review the requested domains.

## 61. Validate plugin extensions and checksums
- Status: planned
- Files: apps/infraweaver-console/src/app/api/game-hub/servers/[name]/plugins/route.ts
- Plan: Require allowed file extensions and optional checksums for plugin and mod installations before any download or pod-side write happens.
- Bypass / defense in depth: This blocks simple malware drops and improves supply-chain hygiene for community packages.
- Monitoring / verification: Log plugin sources and checksum mismatches to a dedicated security stream.

## 62. Stop zip-slip and path traversal in game-hub file actions
- Status: planned
- Files: apps/infraweaver-console/src/app/api/game-hub/servers/[name]/files/route.ts; apps/infraweaver-console/src/app/api/game-hub/servers/[name]/files/content/route.ts; apps/infraweaver-console/src/app/api/game-hub/servers/[name]/files/upload/route.ts
- Plan: Normalize and enforce server-root-relative paths before rename, extract, upload, or content-save operations.
- Bypass / defense in depth: This blocks archive entries and crafted paths from escaping the intended server filesystem subtree.
- Monitoring / verification: Audit rejected paths and inspect repeated attempts as active exploitation.

## 63. Use signed upload tickets for file uploads
- Status: planned
- Files: apps/infraweaver-console/src/app/api/game-hub/servers/[name]/files/upload/route.ts; apps/infraweaver-console/src/app/(dashboard)/game-hub/**
- Plan: Issue short-lived signed upload intents tied to server, path, size, and actor before accepting file uploads.
- Bypass / defense in depth: This prevents replay and constrains clients from reusing a general upload endpoint for arbitrary targets.
- Monitoring / verification: Track upload-ticket issuance, redemption, and expiry metrics.

## 64. Hash or classify exec commands in audit logs
- Status: planned
- Files: apps/infraweaver-console/src/app/api/pods/exec/route.ts; apps/infraweaver-console/src/app/api/game-hub/servers/[name]/exec/route.ts; apps/infraweaver-console/src/app/api/game-hub/servers/[name]/rcon/route.ts
- Plan: Store a command class or hash plus a short human label instead of raw command bodies when the command text could contain secrets or player data.
- Bypass / defense in depth: This preserves accountability while reducing data leakage in logs.
- Monitoring / verification: Alert on high-risk command classes such as shell, env, or token inspection.

## 65. Replace pods/exec string splitting with explicit argv maps
- Status: planned
- Files: apps/infraweaver-console/src/app/api/pods/exec/route.ts
- Plan: Map each allowed diagnostic command to an exact argument array rather than splitting a string at runtime before kubectl exec.
- Bypass / defense in depth: This removes edge cases around whitespace, quoting, and future allowlist expansion mistakes.
- Monitoring / verification: Add unit tests that assert every allowed label maps to the intended argv array.

## 66. Alert on repeated denied exec and rcon actions
- Status: planned
- Files: apps/infraweaver-console/src/app/api/pods/exec/route.ts; apps/infraweaver-console/src/app/api/game-hub/servers/[name]/rcon/route.ts; apps/infraweaver-console/src/lib/audit-log.ts
- Plan: Turn repeated denied console actions into security alerts because they are strong indicators of privilege probing.
- Bypass / defense in depth: This catches misuse of compromised viewer accounts before an attacker finds a writable route.
- Monitoring / verification: Page when the same user or IP crosses a denial threshold within a short period.

## 67. Enforce per-server scoping on every game-hub mutation route
- Status: planned
- Files: apps/infraweaver-console/src/app/api/game-hub/servers/**
- Plan: Audit tokens, backups, webhooks, files, players, and process routes to ensure every mutation resolves permissions against the target server scope, not only a broad game-hub role.
- Bypass / defense in depth: This prevents global game-hub roles from bleeding into server-specific administration by mistake.
- Monitoring / verification: Log any route that falls back to root game-hub scope during the migration.

## 68. Use shared namespace, pod, and container validators everywhere
- Status: planned
- Files: apps/infraweaver-console/src/lib/validate.ts; apps/infraweaver-console/src/app/api/pods/**; apps/infraweaver-console/src/app/api/logs/**; apps/infraweaver-console/src/app/api/cluster/**
- Plan: Replace ad hoc regexes with the shared validation helpers so every route checks the same RFC-conformant identifiers.
- Bypass / defense in depth: This reduces tiny inconsistencies that attackers use to reach alternate parsing branches.
- Monitoring / verification: Add tests covering kube-system style names, long names, and invalid edge cases.

## 69. Redact secrets from streamed logs
- Status: planned
- Files: apps/infraweaver-console/src/app/api/logs/stream/route.ts; apps/infraweaver-console/src/app/api/logs/[namespace]/[pod]/[container]/route.ts
- Plan: Apply lightweight server-side filters for obvious bearer tokens, passwords, and keys before shipping logs to the browser.
- Bypass / defense in depth: This reduces accidental disclosure from pods that log credentials and limits abuse of the console as a secret browser.
- Monitoring / verification: Track redaction counts per namespace to identify noisy apps that need their own fixes.

## 70. Cap homepage and webhook diagnostic output
- Status: planned
- Files: apps/infraweaver-console/src/app/api/homepage-ping/route.ts; apps/infraweaver-console/src/app/api/webhooks/test/route.ts
- Plan: Keep both outbound diagnostic endpoints on strict response-size and timeout budgets with clear truncation markers.
- Bypass / defense in depth: This stops them from becoming general-purpose data pumps to or from untrusted endpoints.
- Monitoring / verification: Graph truncation rates and timeout rates by destination.

## 71. Add CI guard for req.json without zod
- Status: planned
- Files: apps/infraweaver-console/package.json; .github/workflows/**
- Plan: Add a static check in CI that fails when new API routes parse JSON without a neighboring zod schema or approved helper call.
- Bypass / defense in depth: This turns a recurring review comment into an automated regression barrier.
- Monitoring / verification: Report the exact files in PR comments so the fix is obvious.

## 72. Add CI guard for mutation routes missing rate-limit and audit calls
- Status: planned
- Files: apps/infraweaver-console/package.json; .github/workflows/**
- Plan: Check new POST, PATCH, PUT, and DELETE handlers for a route-specific or middleware rate limit plus an audit call when they mutate state.
- Bypass / defense in depth: This keeps future hardening from regressing when new features land quickly.
- Monitoring / verification: Publish a weekly report of routes exempted from the rule and why.

## 73. Ban group-only permission checks in app/api through CI
- Status: planned
- Files: apps/infraweaver-console/package.json; .github/workflows/**
- Plan: Fail CI when hasPermission is called with raw groups in API routes unless the file is on a documented allowlist.
- Bypass / defense in depth: This forces the codebase toward session-aware RBAC and prevents new legacy checks from spreading.
- Monitoring / verification: Track remaining exemptions until the list reaches zero.

## 74. Ban mock security data in production code paths
- Status: planned
- Files: apps/infraweaver-console/src/app/api/security/**; apps/infraweaver-console/src/app/api/health/**
- Plan: Require explicit development guards around mock data so production cannot silently fall back to sample rows in security-sensitive APIs.
- Bypass / defense in depth: This keeps operators from mistaking placeholder posture for real telemetry during outages.
- Monitoring / verification: Alert when a route serves mock or unavailable data in a non-development environment.

## 75. Add secret scanning for console and integration tokens
- Status: planned
- Files: .github/workflows/**; .pre-commit-config.yaml; apps/infraweaver-console/**
- Plan: Run secret scanners on pushes and PRs to catch leaked Authentik, registry, NetBird, and webhook tokens before merge.
- Bypass / defense in depth: This lowers the chance that hardening work itself introduces a new credential leak.
- Monitoring / verification: Track detection counts and false positives by rule family.
## 76. Generate an SBOM for the console image
- Status: planned
- Files: apps/infraweaver-console/package.json; .github/workflows/**; kubernetes/catalog/infraweaver-console/**
- Plan: Produce an SBOM for every console image build and attach it to artifacts or releases for traceability.
- Bypass / defense in depth: This improves incident response when a library CVE lands and makes image provenance reviewable.
- Monitoring / verification: Alert when SBOM generation fails or drifts from deployed digests.

## 77. Sign the console image and verify it in-cluster
- Status: planned
- Files: .github/workflows/**; kubernetes/core/kyverno/manifests/**; kubernetes/catalog/infraweaver-console/**
- Plan: Sign published console images and add an admission policy that only allows trusted signatures for the console workload.
- Bypass / defense in depth: This prevents tag replacement and registry tampering from silently shipping hostile builds.
- Monitoring / verification: Monitor admission failures and unsigned image attempts by namespace.

## 78. Run the console with a read-only root filesystem
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**
- Plan: Set readOnlyRootFilesystem and move writable paths to explicit tmpfs or emptyDir mounts only where required.
- Bypass / defense in depth: This limits persistence opportunities if the app or one of its dependencies is exploited.
- Monitoring / verification: Alert when the pod requests unexpected writable mounts after the change.

## 79. Enforce non-root, dropped capabilities, and seccomp on console pods
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**; kubernetes/core/kyverno/manifests/**
- Plan: Set runAsNonRoot, drop all capabilities, and use RuntimeDefault seccomp for the console deployment with policy backup from Kyverno.
- Bypass / defense in depth: This makes container escapes and post-exploit tooling substantially harder.
- Monitoring / verification: Report policy violations and pod restarts caused by securityContext drift.

## 80. Disable automountServiceAccountToken if not required
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**; apps/infraweaver-console/src/lib/kube-client.ts
- Plan: Review whether the console can use an injected kubeconfig or proxy and disable SA token automount if direct API calls are unnecessary.
- Bypass / defense in depth: This removes one of the most valuable secrets from the pod filesystem.
- Monitoring / verification: Alert when code paths still assume an in-cluster token after the cutover.

## 81. Review console service-account and ClusterRole privileges
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**; kubernetes/core/**
- Plan: Map the exact Kubernetes verbs the console uses and reduce its RBAC to the minimal set for reads, exec, and approved mutations.
- Bypass / defense in depth: This shrinks blast radius if the pod or a privileged route is compromised.
- Monitoring / verification: Run a scheduled RBAC diff against the least-privilege manifest and page on drift.

## 82. Restrict console egress with NetworkPolicy
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**
- Plan: Allow egress only to kube-apiserver, Authentik, registry, approved webhook destinations, and DNS from the console namespace.
- Bypass / defense in depth: This limits SSRF follow-on impact and constrains a compromised pod’s reach inside the cluster.
- Monitoring / verification: Use denied-egress metrics from the CNI or Falco to tune the rule set.

## 83. Add PDB and resource guardrails to the console deployment
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**
- Plan: Define requests, limits, and a PodDisruptionBudget so the security console stays available during node churn and resists noisy-neighbor DoS.
- Bypass / defense in depth: This is defense in depth for availability because security tools are most needed during incidents.
- Monitoring / verification: Watch eviction counts, throttle events, and budget exhaustion.

## 84. Back console hardening with Kyverno policy
- Status: planned
- Files: kubernetes/core/kyverno/manifests/**; kubernetes/catalog/infraweaver-console/**
- Plan: Write a targeted policy that enforces securityContext, probes, and automount settings for the console namespace so drift is blocked early.
- Bypass / defense in depth: This keeps manual manifest edits or Helm upgrades from weakening the deployment over time.
- Monitoring / verification: Surface Kyverno violations for infraweaver-console in the security dashboard.

## 85. Block unpinned images on console and API workloads
- Status: planned
- Files: kubernetes/core/kyverno/manifests/**; kubernetes/catalog/infraweaver-console/**; apps/infraweaver-api/**
- Plan: Require digest-pinned images or trusted registries for the console and closely related control-plane workloads.
- Bypass / defense in depth: This reduces supply-chain risk from mutable tags and improves rollback certainty.
- Monitoring / verification: Alert when deployment attempts use floating tags in protected namespaces.

## 86. Add a Falco rule for console-originated exec activity
- Status: planned
- Files: kubernetes/monitoring/**; docs/**
- Plan: Create a runtime rule that watches for kubectl exec or shell execution inside the console pod and flags unexpected patterns.
- Bypass / defense in depth: This catches successful post-exploit behavior even if the API path looked legitimate on paper.
- Monitoring / verification: Page on execs outside approved maintenance windows or commands.

## 87. Rotate Authentik, registry, and NetBird credentials automatically
- Status: planned
- Files: ExternalSecrets manifests under kubernetes/**; apps/infraweaver-console/src/lib/authentik.ts; apps/infraweaver-console/src/app/api/registry/**
- Plan: Move integration secrets to short-lived or rotated credentials with expiry metadata and replacement playbooks.
- Bypass / defense in depth: This reduces long-term token exposure and makes leaked secrets less durable.
- Monitoring / verification: Alert before expiry and on failed rotations.

## 88. Split service credentials by integration and permission
- Status: planned
- Files: apps/infraweaver-console/src/lib/authentik.ts; apps/infraweaver-console/src/app/api/registry/**; kubernetes/catalog/infraweaver-console/**
- Plan: Use separate least-privilege credentials for Authentik reads, Authentik writes, registry reads, and webhook tests instead of broad shared tokens.
- Bypass / defense in depth: This prevents compromise of one feature from granting broad cross-system access.
- Monitoring / verification: Inventory credential usage by secret name and rotate any credential that remains shared.

## 89. Protect audit logs against tampering and loss
- Status: planned
- Files: apps/infraweaver-console/src/app/api/security/audit-log/route.ts; kubernetes/catalog/infraweaver-console/**
- Plan: Move the audit store off ConfigMap or add signed snapshots, backup, and retention rules so attackers cannot easily truncate history.
- Bypass / defense in depth: This improves integrity during incident response and avoids losing the oldest entries first during spam.
- Monitoring / verification: Alert on sudden drops in entry count or failed backup jobs.

## 90. Add canary tests for unauthorized access to security APIs
- Status: planned
- Files: apps/infraweaver-console/tests/**; .github/workflows/**
- Plan: Create automated tests that assert unauthenticated and low-privilege users get 401 or 403 from every /api/security route.
- Bypass / defense in depth: This prevents future UI-driven assumptions from hiding broken server-side gates.
- Monitoring / verification: Publish canary results after every deployment and block promotion on failures.

## 91. Review secure-headers middleware on live routes
- Status: planned
- Files: kubernetes/platform/external-routes/manifests/**; apps/infraweaver-console/next.config.js
- Plan: Confirm the console ingress and any related routes still chain the expected secure-headers middleware and do not bypass Next.js header policy.
- Bypass / defense in depth: This catches ingress drift that would silently weaken CSP, HSTS, or framing protections.
- Monitoring / verification: Add a scheduled cluster check that compares live middleware attachments to git.

## 92. Add dashboards for rate-limit, body-limit, CSRF, and auth failures
- Status: planned
- Files: apps/infraweaver-console/src/lib/audit-log.ts; kubernetes/monitoring/**
- Plan: Turn the new defensive checks into first-class metrics and dashboards so operators can see abuse trends rather than just code paths.
- Bypass / defense in depth: This makes hardening actionable because controls that never get observed quietly rot.
- Monitoring / verification: Page on sudden spikes by route or principal type.

## 93. Create a security regression checklist for PRs
- Status: planned
- Files: .github/memories/**; .github/PULL_REQUEST_TEMPLATE.md
- Plan: Document the route-review checklist for auth, validation, rate limits, audit, and data leakage so future changes follow the same bar.
- Bypass / defense in depth: This keeps the hardening work from fading as the codebase grows and contributors change.
- Monitoring / verification: Review the checklist monthly and update it with bugs found in the wild.

## 94. Run a live-cluster review of the console namespace after deployment
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**; kubernetes/platform/external-routes/manifests/**; kubernetes/core/kyverno/manifests/**
- Plan: After code changes land, inspect the running console namespace for SA, RBAC, NetworkPolicy, ingress headers, and Kyverno compliance gaps that code review cannot prove.
- Bypass / defense in depth: This ties application hardening back to the real deployment and catches configuration drift that would nullify secure code paths.
- Monitoring / verification: Record the review results in a follow-up memory and alert on any drift found.

## 95. Sanitize innerHTML usage in the apps dashboard
- Status: planned
- Files: apps/infraweaver-console/src/app/(dashboard)/apps/page.tsx
- Plan: Replace direct innerHTML icon injection with React-rendered SVG components or a sanitized mapping layer.
- Bypass / defense in depth: This removes an XSS footgun that makes a future data-source bug much more dangerous.
- Monitoring / verification: Add an ESLint rule or grep check that flags new innerHTML assignments.

## 96. Move the theme bootstrap off inline script and onto a CSP nonce path
- Status: planned
- Files: apps/infraweaver-console/src/app/layout.tsx; apps/infraweaver-console/next.config.js
- Plan: Replace the inline theme loader with a nonce-backed script or server-rendered class selection so global unsafe-inline can be removed.
- Bypass / defense in depth: This shrinks the XSS blast radius and makes CSP materially protective instead of mostly advisory.
- Monitoring / verification: Track CSP violation reports before and after the transition.

## 97. Remove unsafe-eval from the global CSP after editor isolation
- Status: planned
- Files: apps/infraweaver-console/next.config.js; apps/infraweaver-console/src/app/(dashboard)/**
- Plan: Isolate Monaco or any eval-dependent screens behind a stricter sandbox or lazy-loaded route so the default CSP does not need unsafe-eval.
- Bypass / defense in depth: This blocks a broad class of injected script execution paths even if a rendering bug appears elsewhere.
- Monitoring / verification: Use staged CSP report-only headers first and review blocked sources.

## 98. Add route-specific no-store headers on all sensitive reads
- Status: planned
- Files: apps/infraweaver-console/src/lib/route-utils.ts; apps/infraweaver-console/src/app/api/profile/**; apps/infraweaver-console/src/app/api/users/**; apps/infraweaver-console/src/app/api/security/**
- Plan: Apply explicit no-store headers to profile, user-management, and security responses so browser and proxy caches never retain sensitive data.
- Bypass / defense in depth: This complements middleware cache-control and protects routes that may be served outside the standard middleware path later.
- Monitoring / verification: Add integration tests that assert cache headers on sensitive endpoints.

## 99. Add Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy where compatible
- Status: planned
- Files: apps/infraweaver-console/next.config.js; kubernetes/platform/external-routes/manifests/**
- Plan: Test and roll out stricter browser isolation headers so unrelated origins cannot easily interact with or embed console resources.
- Bypass / defense in depth: This reduces cross-origin data leaks and clickjacking-adjacent abuse beyond basic frame restrictions.
- Monitoring / verification: Roll out in report-only or staged fashion and watch browser console error rates.

## 100. Run a live-cluster review of console RBAC, service-account, NetworkPolicy, and middleware after deployment
- Status: planned
- Files: kubernetes/catalog/infraweaver-console/**; kubernetes/platform/external-routes/manifests/**; kubernetes/core/kyverno/manifests/**; .github/memories/**
- Plan: After shipping this branch, validate the deployed console namespace, ingress, and policy attachments on the production cluster and capture findings in a follow-up memory.
- Bypass / defense in depth: This confirms the application-layer fixes are not undermined by cluster drift, stale manifests, or mismatched route middleware.
- Monitoring / verification: Store the review output in memories and turn any discovered drift into tracked follow-up changes.
