import { auth } from "@/lib/auth";
import { checkSameOrigin, getRequestSizeViolation, hasUpstreamFeedbackSignature, internalCronTokenMatches } from "@/lib/api-helpers";
import { auditUnauthorizedAccess } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey, UNAUTHENTICATED_RATE_LIMIT } from "@/lib/rate-limit";
import { NextResponse, type NextRequest } from "next/server";


const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_EXACT_PATHS = new Set([
  "/login",
  "/auth/signin",
  "/favicon.ico",
  "/api/ping",
  "/api/health",
  "/api/game-hub/public-status",
]);
const PUBLIC_PATTERNS = [/^\/api\/game-hub\/servers\/[^/]+\/badge$/];
const PUBLIC_PREFIXES = ["/api/auth", "/_next", "/public"];
const RATE_LIMIT_EXEMPT_PATHS = new Set([
  "/favicon.ico",
  "/api/ping",
  "/api/health",
  "/api/game-hub/public-status",
]);
const PUBLIC_FILE_RE = /\.[a-z0-9]+$/i;
const AUTHENTICATED_MUTATION_RATE_LIMIT = { max: 30, windowMs: 60_000 };

function isPublicPath(pathname: string) {
  // PUBLIC_FILE_RE only ever matches genuine static assets — never API routes.
  // An API path that happens to end in a "file extension" (e.g. a content-type
  // trick like /api/users/export.csv) must NOT be treated as public, so gate the
  // file-extension allowance behind a non-/api guard.
  const isStaticFile = !pathname.startsWith("/api/") && PUBLIC_FILE_RE.test(pathname);
  return PUBLIC_EXACT_PATHS.has(pathname) || PUBLIC_PREFIXES.some((entry) => pathname.startsWith(entry)) || isStaticFile || PUBLIC_PATTERNS.some((re) => re.test(pathname));
}

function buildLoginUrl(req: Pick<NextRequest, "nextUrl">) {
  const loginUrl = new URL("/login", req.nextUrl);
  loginUrl.searchParams.set("callbackUrl", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return loginUrl;
}

function withApiCacheControl(pathname: string, response: NextResponse) {
  if (!pathname.startsWith("/api/")) return response;
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

/**
 * Generates a cryptographically random nonce for CSP.
 * Uses Web Crypto API (globalThis.crypto) — available in the Node.js runtime
 * that Proxy always runs on (Next.js 16+).
 */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Builds per-request CSP with the nonce in script-src.
 * 'strict-dynamic' + nonce causes CSP3 browsers to ignore 'unsafe-inline',
 * while 'unsafe-inline' remains as fallback for CSP1/2 browsers.
 */
function buildCSP(nonce: string): string {
  // Next.js dev mode needs 'unsafe-eval'; production must NOT allow it.
  const scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'${
    process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""
  }`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' wss: ws:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Creates a NextResponse.next() that also forwards the nonce and requestId
 * in request headers so Server Components can read them via next/headers.
 */
function nextWithContext(req: NextRequest, nonce: string, requestId: string): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

function withSecurityHeaders(response: NextResponse, nonce: string, requestId: string): NextResponse {
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("x-nonce", nonce);
  // Dynamic per-request CSP with nonce (overrides static header set in next.config.js)
  response.headers.set("Content-Security-Policy", buildCSP(nonce));
  // Prevent clickjacking — DENY is more restrictive than SAMEORIGIN; frame-ancestors 'none' in CSP covers modern browsers
  response.headers.set("X-Frame-Options", "DENY");
  // Stop browsers from guessing MIME types
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Don't send referrer to other origins
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Restrict powerful browser APIs to same origin
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // Remove server fingerprint header
  response.headers.delete("X-Powered-By");
  // HSTS — only set on HTTPS responses (the browser ignores it on HTTP)
  if (response.headers.get("content-type")?.includes("text/html") || !response.headers.has("content-type")) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  return response;
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
function bearerTokenFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export default auth(async (req) => {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;
  const isApiRoute = pathname.startsWith("/api/");
  const nonce = generateNonce();
  const requestId = crypto.randomUUID();

  try {
    const isPublic = isPublicPath(pathname);
    const isLoggedIn = !!req.auth;

    // Internal cron caller: the hourly WordPress health-sweep CronJob POSTs here
    // with a shared token instead of a session (see wordpress-manager
    // healthSweepHandler). When the token matches, let the request past the
    // session gate AND the CSRF same-origin check untouched — the route handler
    // re-validates the same token (defence in depth). Fail-closed: a missing or
    // wrong token falls through to the normal auth path and is rejected there.
    // Kept ahead of the rate-limit/CSRF/auth blocks so the sole authenticator
    // for this path is the token, not request shape.
    if (
      pathname === "/api/wordpress/health-sweep" &&
      req.method === "POST" &&
      internalCronTokenMatches(req.headers.get("x-internal-cron-token"), process.env.WORDPRESS_HEALTH_CRON_TOKEN)
    ) {
      return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
    }

    // Internal cron caller: the daily WordPress key-reroll sweep CronJob POSTs
    // here with its OWN dedicated token (distinct from the health-sweep token —
    // fleet key-rotation is higher impact; SECURITY-SCAN-2026-07-18 M2). Same
    // fail-closed contract — a missing/wrong token falls through to the auth wall
    // and the route handler re-validates the token (defence in depth). Kept ahead
    // of the rate-limit/CSRF/auth blocks so the sole authenticator is the token.
    if (
      pathname === "/api/wordpress/rotation-sweep" &&
      req.method === "POST" &&
      internalCronTokenMatches(req.headers.get("x-internal-cron-token"), process.env.WORDPRESS_ROTATION_CRON_TOKEN)
    ) {
      return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
    }

    // Internal cron caller: the users-reconcile CronJob POSTs here with a shared
    // token instead of a session (see lib/users/reconcile.ts). Same fail-closed
    // contract as the health-sweep bypass above — a missing/wrong token falls
    // through to the normal auth path and is rejected; the route handler
    // re-validates the token (defence in depth). Kept ahead of the
    // rate-limit/CSRF/auth blocks so the sole authenticator is the token.
    if (
      pathname === "/api/users/reconcile" &&
      req.method === "POST" &&
      internalCronTokenMatches(req.headers.get("x-internal-cron-token"), process.env.USERS_RECONCILE_CRON_TOKEN)
    ) {
      return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
    }

    // Internal cron caller: the roster-drift CronJob GETs here with a shared token
    // instead of a session (see lib/security/roster-drift.ts). Read-only, so no CSRF
    // concern — the session gate is the only wall to pass. Same fail-closed contract
    // as the reconcile bypass above: a missing/wrong token falls through to the auth
    // wall and is rejected; the route handler re-validates the token (defence in
    // depth). Kept ahead of the rate-limit/auth blocks so the sole authenticator is
    // the token.
    if (
      pathname === "/api/security/roster-drift" &&
      req.method === "GET" &&
      internalCronTokenMatches(req.headers.get("x-internal-cron-token"), process.env.ROSTER_DRIFT_CRON_TOKEN)
    ) {
      return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
    }

    // Prometheus scrape: the ServiceMonitor GETs /api/wordpress/metrics with a
    // Bearer token (bearerTokenSecret) instead of a session — the IWSL Connector
    // fleet exporter. Read-only, so no CSRF concern — the session gate is the
    // only wall to pass. Same fail-closed contract as the cron bypasses above: a
    // missing/wrong token falls through to the auth wall and is rejected, and the
    // route handler re-validates the SAME token (defence in depth). Kept ahead of
    // the rate-limit/auth blocks so the sole authenticator is the token.
    if (
      pathname === "/api/wordpress/metrics" &&
      req.method === "GET" &&
      internalCronTokenMatches(bearerTokenFrom(req.headers.get("authorization")), process.env.WORDPRESS_METRICS_TOKEN)
    ) {
      return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
    }

    // Cross-deployment ("upstream") feedback ingest: a fork forwards an
    // HMAC-signed copy of user feedback to the canonical endpoint with NO session
    // and NO same-origin Origin (it is a server-side fetch). Let a POST carrying
    // BOTH feedback HMAC headers past the session gate AND the CSRF same-origin
    // check; the /api/feedback route handler then verifies the signature and
    // fails closed on a forged/expired one (defence in depth). Mirrors the
    // health-sweep token bypass above — presence-only, grants no trust: forged or
    // absent signatures are still rejected downstream (bad → 401 at the handler,
    // no headers → never reaches here, so anon → 401 at the auth wall). Kept ahead
    // of the rate-limit/CSRF/auth blocks so the sole authenticator is the HMAC.
    if (
      pathname === "/api/feedback" &&
      req.method === "POST" &&
      hasUpstreamFeedbackSignature(req)
    ) {
      // Run the (method+path based) body-size guard BEFORE granting the HMAC
      // bypass, otherwise a request merely carrying the signature headers reaches
      // the handler unbounded — an unauthenticated memory-exhaustion vector.
      const sizeViolation = getRequestSizeViolation(req, pathname);
      if (sizeViolation) {
        await auditUnauthorizedAccess("security:request-too-large", req, req.auth?.user?.email ?? "anonymous", `${req.method} ${pathname} — ${sizeViolation}`);
        return withSecurityHeaders(NextResponse.json({ error: "Request body too large" }, { status: 413 }), nonce, requestId);
      }
      return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
    }

    // NOTE: login rate limiting for /api/auth/signin is enforced in the Auth.js
    // route handler (app/api/auth/[...nextauth]/route.ts), NOT here — config.matcher
    // below excludes /api/auth/, so any signin guard placed in this middleware is
    // unreachable dead code. Keep the limiter in the route, not in the proxy.

    if (!isLoggedIn && !RATE_LIMIT_EXEMPT_PATHS.has(pathname) && !pathname.startsWith("/_next")) {
      if (!checkRateLimit(rateLimitKey("unauthenticated", req), UNAUTHENTICATED_RATE_LIMIT.max, UNAUTHENTICATED_RATE_LIMIT.windowMs)) {
        const r = isApiRoute
          ? NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
          : new NextResponse("Rate limit exceeded", { status: 429 });
        r.headers.set("Retry-After", "60");
        return withSecurityHeaders(r, nonce, requestId);
      }
    }

    if (isApiRoute && MUTATION_METHODS.has(req.method) && !pathname.startsWith("/api/auth")) {
      const sizeViolation = getRequestSizeViolation(req, pathname);
      if (sizeViolation) {
        await auditUnauthorizedAccess("security:request-too-large", req, req.auth?.user?.email ?? "anonymous", `${req.method} ${pathname} — ${sizeViolation}`);
        return withSecurityHeaders(NextResponse.json({ error: "Request body too large" }, { status: 413 }), nonce, requestId);
      }
    }

    if (isApiRoute && MUTATION_METHODS.has(req.method) && !pathname.startsWith("/api/auth") && !checkSameOrigin(req)) {
      await auditUnauthorizedAccess("security:csrf-rejected", req, req.auth?.user?.email ?? "anonymous", `${req.method} ${pathname}`);
      return withSecurityHeaders(NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 }), nonce, requestId);
    }

    if (isLoggedIn && isApiRoute && MUTATION_METHODS.has(req.method) && !pathname.startsWith("/api/auth")) {
      if (!checkRateLimit(rateLimitKey(`mutation:${pathname}`, req), AUTHENTICATED_MUTATION_RATE_LIMIT.max, AUTHENTICATED_MUTATION_RATE_LIMIT.windowMs)) {
        const r = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
        r.headers.set("Retry-After", "60");
        return withSecurityHeaders(r, nonce, requestId);
      }
    }

    if (!isLoggedIn && !isPublic) {
      await auditUnauthorizedAccess("auth:unauthorized", req, "anonymous", `${req.method} ${pathname}`);
      if (isApiRoute) {
        return withSecurityHeaders(
          withApiCacheControl(pathname, NextResponse.json({ error: "Unauthorized", loginUrl: buildLoginUrl(req).toString() }, { status: 401 })),
          nonce,
          requestId,
        );
      }
      return withSecurityHeaders(NextResponse.redirect(buildLoginUrl(req)), nonce, requestId);
    }

    if (isLoggedIn && (pathname === "/login" || pathname === "/auth/signin")) {
      const callbackUrl = nextUrl.searchParams.get("callbackUrl");
      // Guard: reject callbackUrls that would loop back into the auth flow,
      // chain redirects, or escape the origin. The "//" check blocks
      // protocol-relative URLs (e.g. //evil.com) that startsWith("/") lets
      // through as an open redirect.
      const passesCheapChecks =
        callbackUrl != null &&
        callbackUrl.startsWith("/") &&
        !callbackUrl.startsWith("//") &&
        !callbackUrl.startsWith("/login") &&
        !callbackUrl.startsWith("/auth/signin") &&
        !callbackUrl.startsWith("/api/auth") &&
        !callbackUrl.includes("callbackUrl=");
      // Defense in depth: resolve against the request origin and confirm it does
      // not escape it before trusting the redirect target.
      let isValidCallback = false;
      if (passesCheapChecks) {
        try {
          isValidCallback = new URL(callbackUrl, nextUrl).origin === nextUrl.origin;
        } catch {
          isValidCallback = false;
        }
      }
      const target = isValidCallback ? new URL(callbackUrl as string, nextUrl) : new URL("/", nextUrl);
      return withSecurityHeaders(NextResponse.redirect(target), nonce, requestId);
    }

    return withSecurityHeaders(withApiCacheControl(pathname, nextWithContext(req, nonce, requestId)), nonce, requestId);
  } catch (error) {
    console.error("middleware recovery fallback", error);
    if (isApiRoute) {
      return withSecurityHeaders(
        withApiCacheControl(pathname, NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 })),
        nonce,
        requestId,
      );
    }
    // Fail closed: if we could not evaluate auth for a page route, do NOT let the
    // request through unauthenticated. Redirect to login (the auth flow re-runs
    // cleanly), except for genuinely public paths which would otherwise loop.
    if (isPublicPath(pathname)) {
      return withSecurityHeaders(nextWithContext(req, nonce, requestId), nonce, requestId);
    }
    return withSecurityHeaders(NextResponse.redirect(buildLoginUrl(req)), nonce, requestId);
  }
});

export const config = {
  // Exclude /api/auth/* from middleware so Auth.js route handler ([...nextauth]/route.ts)
  // handles auth endpoints directly. The auth(handler) middleware wrapper intercepts
  // /api/auth/* itself and its internal signin handler throws UnknownAction in v5 beta.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth/).*)"],
};
