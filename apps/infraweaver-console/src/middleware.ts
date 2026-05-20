import { auth } from "@/lib/auth";
import { checkSameOrigin, getRequestSizeViolation } from "@/lib/api-helpers";
import { auditAuthFailure, auditUnauthorizedAccess } from "@/lib/audit-log";
import { checkRateLimit, LOGIN_RATE_LIMIT, rateLimitKey, UNAUTHENTICATED_RATE_LIMIT } from "@/lib/rate-limit";
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
  return PUBLIC_EXACT_PATHS.has(pathname) || PUBLIC_PREFIXES.some((entry) => pathname.startsWith(entry)) || PUBLIC_FILE_RE.test(pathname);
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
 * Uses Web Crypto API (globalThis.crypto) — safe in edge runtime.
 */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function withSecurityHeaders(response: NextResponse, nonce: string, requestId: string): NextResponse {
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("x-nonce", nonce);
  return response;
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

    if (pathname.startsWith("/api/auth/signin") && MUTATION_METHODS.has(req.method)) {
      if (!checkRateLimit(rateLimitKey("login", req), LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs)) {
        await auditAuthFailure(`Rate limited login attempt for ${pathname}`, req);
        const r = NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
        r.headers.set("Retry-After", "60");
        return withSecurityHeaders(r, nonce, requestId);
      }
    }

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
      return NextResponse.redirect(buildLoginUrl(req));
    }

    if (isLoggedIn && (pathname === "/login" || pathname === "/auth/signin")) {
      const callbackUrl = nextUrl.searchParams.get("callbackUrl");
      // Guard: reject callbackUrls that would loop back into the auth flow
      const isValidCallback =
        callbackUrl != null &&
        callbackUrl.startsWith("/") &&
        !callbackUrl.startsWith("/login") &&
        !callbackUrl.startsWith("/auth/signin") &&
        !callbackUrl.startsWith("/api/auth");
      const target = isValidCallback ? new URL(callbackUrl, nextUrl) : new URL("/", nextUrl);
      return NextResponse.redirect(target);
    }

    return withSecurityHeaders(withApiCacheControl(pathname, NextResponse.next()), nonce, requestId);
  } catch (error) {
    console.error("middleware recovery fallback", error);
    if (isApiRoute) {
      return withSecurityHeaders(
        withApiCacheControl(pathname, NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 })),
        nonce,
        requestId,
      );
    }
    return withSecurityHeaders(NextResponse.next(), nonce, requestId);
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
