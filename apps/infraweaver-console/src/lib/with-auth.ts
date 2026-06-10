// ─────────────────────────────────────────────────────────────────────────────
// with-auth.ts — typed wrapper that collapses the route guard chain repeated
// across ~200 API routes:
//   auth() → 401 → RBAC → 403 → (optional) rate limit → 429 → try/catch →
//   safeError → 500 → JSON envelope.
//
// Reuses the existing helpers (no new auth logic):
//   - auth()                         (lib/auth)
//   - getSessionRBACContext / hasAnySessionPermission (lib/session-rbac)
//   - checkRateLimit / rateLimitKey  (lib/rate-limit)
//   - safeError                      (lib/utils)
//
// A handler returns either a NextResponse (full control over status/body — used
// where a route has custom error codes) or a plain value (auto-JSON 200).
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const DEFAULT_RBAC_REVALIDATE_SECONDS = 60;

export interface AuthedContext<P> {
  req: NextRequest;
  session: Session;
  /** Resolved dynamic route params (`{}` for routes without a `[param]`). */
  params: P;
}

export interface WithAuthOptions {
  /** Required permission(s). When an array, ANY-of grants access. Omit for auth-only. */
  permission?: Permission | Permission[];
  /**
   * Scope the permission check to a resource path (e.g. "/game-hub/"). Defaults
   * to "/". Use for routes whose RBAC is resource-scoped rather than global.
   */
  scope?: string;
  /** Optional rate limit applied after the RBAC check. */
  rateLimit?: { name: string; limit: number; windowMs: number };
  /** RBAC context cache window (seconds). Defaults to 60 to match existing routes. */
  revalidateSeconds?: number;
}

type Handler<P> = (ctx: AuthedContext<P>) => Promise<NextResponse | unknown> | NextResponse | unknown;

/** Next.js route second-arg shape — `params` is a Promise in this Next version. */
interface RouteSegment<P> {
  params: Promise<P>;
}

/**
 * Wrap a route handler with the standard auth → RBAC → rate-limit → error
 * envelope. Returns a function with the Next.js route-handler signature.
 */
export function withAuth<P = Record<string, never>>(
  options: WithAuthOptions,
  handler: Handler<P>,
): (req: NextRequest, segment: RouteSegment<P>) => Promise<NextResponse> {
  const permissions =
    options.permission === undefined
      ? []
      : Array.isArray(options.permission)
        ? options.permission
        : [options.permission];

  return async (req: NextRequest, segment: RouteSegment<P>): Promise<NextResponse> => {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (permissions.length > 0) {
      const access = await getSessionRBACContext(
        session,
        options.revalidateSeconds ?? DEFAULT_RBAC_REVALIDATE_SECONDS,
      );
      if (!hasAnySessionPermission(access, permissions, options.scope ?? "/")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    if (options.rateLimit) {
      const { name, limit, windowMs } = options.rateLimit;
      if (!checkRateLimit(rateLimitKey(name, req), limit, windowMs)) {
        return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      }
    }

    try {
      const params = (segment ? await segment.params : ({} as P)) ?? ({} as P);
      const result = await handler({ req, session, params });
      return result instanceof NextResponse ? result : NextResponse.json(result);
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  };
}

/** Consistent success envelope helper (200). */
export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** Consistent error envelope helper. */
export function apiError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
