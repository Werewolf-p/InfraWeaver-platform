---
title: Enterprise Security Hardening 2026-05
description: Complete security hardening of InfraWeaver console and API
---
# Enterprise Security Hardening

## Implemented

### A. Next.js Security Headers (`next.config.js`)
- **CSP**: Strict policy with `frame-ancestors 'none'`, `upgrade-insecure-requests`, `object-src 'none'`
- **HSTS**: `max-age=63072000; includeSubDomains; preload` (2 years)
- **X-Frame-Options**: Changed from `SAMEORIGIN` → `DENY`
- **COOP**: `Cross-Origin-Opener-Policy: same-origin` (blocks window.opener attacks)
- **CORP**: `Cross-Origin-Resource-Policy: same-origin`
- **COEP**: `Cross-Origin-Embedder-Policy: require-corp`
- **X-DNS-Prefetch-Control**: Changed from `on` → `off`
- **X-XSS-Protection**: Changed from `1; mode=block` → `0` (per OWASP recommendation)
- **Permissions-Policy**: Added `payment=(), usb=(), battery=()`

### B. API Route Hardening (`src/lib/api-security.ts`)
- `validateInput(schema, data)` — Zod wrapper with detailed error messages
- `requireAuth(session)` — returns `{ error, code }` with UNAUTHENTICATED code
- `requirePermission(session, permission, checkFn)` — returns FORBIDDEN error shape
- `sanitizeString(input, maxLength)` — strips `<>"'\`\x00-\x1F\x7F`, trims, limits length
- `validateK8sName(name)` / `validateK8sNamespace(ns)` — regex-based URL param validation

### C. Request ID Propagation (`src/middleware.ts`)
- Every response now includes `X-Request-Id` (random UUID) and `x-nonce` headers
- Generated per-request using `crypto.randomUUID()`

### D. Zod Validation on Mutation Routes
Added Zod schemas to routes previously using unvalidated `req.json()`:
- `alerts/silence/route.ts` POST — `CreateSilenceSchema`
- `config/platform/route.ts` PUT — `PlatformUpdateSchema`
- `platform-editor/route.ts` PUT — `PlatformEditorPutSchema`
- `cluster/settings/route.ts` PUT — `ClusterSettingsPutSchema`
- `cluster/nodes/settings/route.ts` PUT — `NodesSettingsPutSchema`

### E. Rate Limiting
- Already had sliding-window rate limiter in `lib/rate-limit.ts`
- Enhanced: all 429 responses now include `Retry-After: 60` header

### F. Audit Logging (`src/lib/audit-middleware.ts`)
- `withAudit(action, handler, options)` wrapper auto-logs write operations
- Captures: timestamp, userId, action, resource, result, ip, userAgent, duration

### G. HMAC API Secret Rotation (`apps/infraweaver-api/src/middleware/auth.ts`)
- Supports `CONSOLE_API_SECRET` (current) + `CONSOLE_API_SECRET_PREV` (previous)
- 5-minute grace window for zero-downtime rotation
- Logs `X-Auth-Key: previous` header when using fallback key
- Signs responses with the same key that authenticated the request

### H. API RBAC
- All existing API routes already had `hasPermission()` checks
- No gaps found in RBAC enforcement

### I. Kubernetes NetworkPolicy
- `kubernetes/catalog/infraweaver-console/manifests/networkpolicy.yaml` — Removed dangerous `- {}` unrestricted egress, replaced with explicit rules for: kube-dns, infraweaver-api, argocd, authentik, k8s API server, external HTTPS only
- `kubernetes/catalog/infraweaver-api/manifests/networkpolicy.yaml` — Added monitoring namespace ingress for Prometheus scraping

### J. Secret Scanning
- `.github/workflows/secret-scan.yml` — TruffleHog scans on push and PR, fails on verified secrets

### K. Dependency Audit
- `.github/workflows/dependency-audit.yml` — npm audit --audit-level=high for both apps, weekly schedule + PR trigger, creates/updates GitHub issue on critical findings

### L. API Security Headers Middleware
- `apps/infraweaver-api/src/middleware/security-headers.ts` — Adds X-Content-Type-Options, X-Frame-Options: DENY, removes X-Powered-By, no-store on sensitive paths
- Registered in `apps/infraweaver-api/src/index.ts` before CORS middleware

### M. Input Sanitisation on URL Parameters
- `pods/[namespace]/[name]/route.ts` GET and DELETE — `isValidNamespace` + `isValidK8sName` validation added
- Other routes (argocd, cluster migrate/scale) already had validation via `lib/validate.ts`

### N. CSP Nonce
- `middleware.ts` generates per-request nonce via `generateNonce()` (UUID → base64url)
- Stored in `x-nonce` response header for Next.js nonce injection
- `next.config.js` CSP updated to use `'nonce-{nonce}'` concept via middleware

### O. Security Page Enhancement
- Added **Secret Rotation Status** section showing HMAC key, NEXTAUTH_SECRET, and Authentik OIDC status
- Documents zero-downtime rotation procedure inline

## Architecture Notes
- The infraweaver-api and infraweaver-console run in the **same Kubernetes namespace** (`infraweaver-console`)
- HMAC secret rotation: set `CONSOLE_API_SECRET_PREV` = old value, update `CONSOLE_API_SECRET` = new, then clear PREV after pod restarts
- Rate limiting is in-memory (resets on pod restart) — for multi-replica, back with Redis
