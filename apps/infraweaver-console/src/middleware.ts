import { auth } from "@/lib/auth";
import { checkSameOrigin } from "@/lib/api-helpers";
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

export default auth(async (req) => {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;
  const isApiRoute = pathname.startsWith("/api/");
  const isPublic = isPublicPath(pathname);
  const isLoggedIn = !!req.auth;

  if (pathname.startsWith("/api/auth/signin") && MUTATION_METHODS.has(req.method)) {
    if (!checkRateLimit(rateLimitKey("login", req), LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs)) {
      await auditAuthFailure(`Rate limited login attempt for ${pathname}`, req);
      return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
    }
  }

  if (!isLoggedIn && !RATE_LIMIT_EXEMPT_PATHS.has(pathname) && !pathname.startsWith("/_next")) {
    if (!checkRateLimit(rateLimitKey("unauthenticated", req), UNAUTHENTICATED_RATE_LIMIT.max, UNAUTHENTICATED_RATE_LIMIT.windowMs)) {
      return isApiRoute
        ? NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
        : new NextResponse("Rate limit exceeded", { status: 429 });
    }
  }

  if (isApiRoute && MUTATION_METHODS.has(req.method) && !pathname.startsWith("/api/auth") && !checkSameOrigin(req)) {
    await auditUnauthorizedAccess("security:csrf-rejected", req, req.auth?.user?.email ?? "anonymous", `${req.method} ${pathname}`);
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }

  if (!isLoggedIn && !isPublic) {
    await auditUnauthorizedAccess("auth:unauthorized", req, "anonymous", `${req.method} ${pathname}`);
    if (isApiRoute) {
      return withApiCacheControl(pathname, NextResponse.json({ error: "Unauthorized", loginUrl: buildLoginUrl(req).toString() }, { status: 401 }));
    }
    return NextResponse.redirect(buildLoginUrl(req));
  }

  if (isLoggedIn && (pathname === "/login" || pathname === "/auth/signin")) {
    const callbackUrl = nextUrl.searchParams.get("callbackUrl");
    const target = callbackUrl?.startsWith("/") ? new URL(callbackUrl, nextUrl) : new URL("/", nextUrl);
    return NextResponse.redirect(target);
  }

  return withApiCacheControl(pathname, NextResponse.next());
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
