---
title: Console Security — CSP Nonce, RBAC withRoute, PermissionGate
description: Security hardening patterns in the infraweaver-console Next.js app.
---

# Console Security Patterns

## Memory

- **App:** `apps/infraweaver-console/`
- **Commit:** `80b3b39c` (May 2026)

## CSP Nonce Architecture

### Problem

Static CSP in `next.config.js` cannot include a per-request nonce. Without a nonce, `'unsafe-inline'` must be used for scripts — weaker security.

### Solution

1. **`middleware.ts`** generates a per-request nonce (`generateNonce()`), builds CSP with `'nonce-{nonce}'` + `'strict-dynamic'`, sets it in the response header.
2. **`next.config.js`** no longer sets a `Content-Security-Policy` header (middleware overrides it for all page/API responses). Static headers remain as defence-in-depth for `_next/static` paths only.
3. **`layout.tsx`** reads the nonce from the `x-nonce` request header (forwarded by middleware) and passes it to the inline theme-detection `<script nonce={nonce}>`.

### Key Functions in middleware.ts

```ts
function buildCSP(nonce: string): string {
  // script-src uses 'nonce-{nonce}' + 'strict-dynamic'
  // 'unsafe-inline' kept as fallback for CSP1/2 browsers
  // 'unsafe-eval' required by Monaco editor in dev
}

function nextWithContext(req, nonce, requestId): NextResponse {
  // Forwards x-nonce and x-request-id to Server Components via request headers
}
```

### Why `'strict-dynamic'`

CSP3 browsers with `'strict-dynamic'` ignore `'unsafe-inline'` entirely — nonce-only enforcement. CSP1/2 browsers fall back to `'unsafe-inline'`.

## RBAC `withRoute()` Wrapper

**File:** `src/lib/route-utils.ts`

Eliminates boilerplate from every API route handler:

```ts
export const GET = withRoute("cluster:read", async (req, session, access, ctx) => {
  // session and access are pre-validated
});

// Auth-only (no permission check):
export const PATCH = withRoute(null, async (req, session) => { ... });

// Any of multiple permissions:
export const POST = withRoute(["apps:write", "catalog:write"], handler);
```

Returns 401 if not authenticated, 403 if permission denied. Wraps handler errors with `routeErrorResponse()`.

## PermissionGate Component

**File:** `src/components/permission-gate.tsx`

```tsx
<PermissionGate permission="cluster:write">
  <DangerButton />
</PermissionGate>

<LockedButton permission="apps:deploy" lockedTitle="Need apps:deploy permission">
  Deploy
</LockedButton>
```

`LockedButton` shows a lock icon + tooltip when user lacks permission. Drop-in replacement for `<button>`.

## Secure Cookie Names

`auth.ts` uses `__Host-` prefix for session cookie (most restrictive — path must be `/`, no domain) and `__Secure-` for other auth cookies when on HTTPS. Detected from `AUTH_URL` / `NEXTAUTH_URL`.

## Lesson Learned

- `RootLayout` must be `async` to call `await headers()` for the nonce. Mark it `async` and import `headers` from `next/headers`.
- The nonce must be forwarded through `nextWithContext()` in middleware request headers so Server Components can read it — response headers are not accessible in RSC.
