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
import type { ZodType } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { accessFieldsFromRequest, logAccess, logMutatingAccess } from "@/lib/access-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { parseBody, requireSingleCluster } from "@/lib/route-utils";

const DEFAULT_RBAC_REVALIDATE_SECONDS = 60;

export interface AuthedContext<P, B = unknown> {
  req: NextRequest;
  session: Session;
  /** Resolved dynamic route params (`{}` for routes without a `[param]`). */
  params: P;
  /** Resolved cluster id — set only when `options.singleCluster` is true. */
  clusterId?: string;
  /** Validated JSON body — set only when `options.bodySchema` is provided. */
  body?: B;
}

export interface WithAuthOptions<B = unknown> {
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
  /**
   * Reject the "all clusters" pseudo-cluster with the canonical 400
   * ("Select a specific cluster before performing this action"); the resolved
   * id lands on `ctx.clusterId`.
   */
  singleCluster?: boolean;
  /** Write a mutating-access log entry (POST/PUT/PATCH/DELETE only) with actor/status/duration. */
  logMutating?: boolean;
  /** Write an access-log entry for EVERY method (including reads). Wins over `logMutating`. */
  accessLog?: boolean;
  /**
   * Validate the JSON body against a zod schema. On failure the route returns
   * the canonical 400 { error: "Validation failed", details } envelope; on
   * success the parsed value lands on `ctx.body`.
   */
  bodySchema?: ZodType<B>;
}

type Handler<P, B = unknown> = (ctx: AuthedContext<P, B>) => Promise<NextResponse | unknown> | NextResponse | unknown;

/** Next.js route second-arg shape — `params` is a Promise in this Next version. */
interface RouteSegment<P> {
  params: Promise<P>;
}

function safeClusterId(req: NextRequest): string | undefined {
  try {
    return getRequestClusterId(req);
  } catch {
    return undefined;
  }
}

/**
 * Wrap a route handler with the standard auth → RBAC → rate-limit → error
 * envelope. Returns a function with the Next.js route-handler signature.
 */
export function withAuth<P = Record<string, never>, B = unknown>(
  options: WithAuthOptions<B>,
  handler: Handler<P, B>,
): (req: NextRequest, segment: RouteSegment<P>) => Promise<NextResponse> {
  const permissions =
    options.permission === undefined
      ? []
      : Array.isArray(options.permission)
        ? options.permission
        : [options.permission];

  return async (req: NextRequest, segment: RouteSegment<P>): Promise<NextResponse> => {
    const startedAt = Date.now();
    // No-op unless logMutating/accessLog is set, so existing callers are untouched.
    const finish = (res: NextResponse, actor: string): NextResponse => {
      if (options.accessLog || options.logMutating) {
        const extra = { clusterId: safeClusterId(req), status: res.status, durationMs: Date.now() - startedAt };
        if (options.accessLog) logAccess(accessFieldsFromRequest(req, actor, extra));
        else logMutatingAccess(req, actor, extra);
      }
      return res;
    };

    const session = await auth();
    if (!session) return finish(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), "unauthenticated");
    const actor = session.user?.email ?? "unknown";

    if (permissions.length > 0) {
      const access = await getSessionRBACContext(
        session,
        options.revalidateSeconds ?? DEFAULT_RBAC_REVALIDATE_SECONDS,
      );
      if (!hasAnySessionPermission(access, permissions, options.scope ?? "/")) {
        return finish(NextResponse.json({ error: "Forbidden" }, { status: 403 }), actor);
      }
    }

    if (options.rateLimit) {
      const { name, limit, windowMs } = options.rateLimit;
      if (!checkRateLimit(rateLimitKey(name, req), limit, windowMs)) {
        return finish(NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }), actor);
      }
    }

    try {
      const params = (segment ? await segment.params : ({} as P)) ?? ({} as P);

      let clusterId: string | undefined;
      if (options.singleCluster) {
        const resolved = requireSingleCluster(req);
        if (resolved instanceof NextResponse) return finish(resolved, actor);
        clusterId = resolved.clusterId;
      }

      let body: B | undefined;
      if (options.bodySchema) {
        const parsed = await parseBody(req, options.bodySchema);
        if (parsed instanceof NextResponse) return finish(parsed, actor);
        body = parsed;
      }

      const result = await handler({ req, session, params, clusterId, body });
      return finish(result instanceof NextResponse ? result : NextResponse.json(result), actor);
    } catch (error) {
      return finish(NextResponse.json({ error: safeError(error) }, { status: 500 }), actor);
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
