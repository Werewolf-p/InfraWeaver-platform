import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import type { SessionRBACContext } from "@/lib/session-rbac";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

export interface ApiResponseOptions {
  status?: number;
  meta?: Record<string, unknown>;
  details?: unknown;
}

export interface RoutePermissionOptions {
  any?: readonly Permission[];
  all?: readonly Permission[];
  ttlSeconds?: number;
}

function withTimestamp(meta?: Record<string, unknown>) {
  return {
    timestamp: new Date().toISOString(),
    ...meta,
  };
}

export function apiSuccess<T>(data: T, options: ApiResponseOptions = {}) {
  return NextResponse.json(
    {
      data,
      meta: withTimestamp(options.meta),
    },
    { status: options.status ?? 200 },
  );
}

export function apiError(message: string, options: ApiResponseOptions = {}) {
  return NextResponse.json(
    {
      error: message,
      ...(options.details === undefined ? {} : { details: options.details }),
      meta: withTimestamp(options.meta),
    },
    { status: options.status ?? 500 },
  );
}

export async function parseJsonBody<T>(request: NextRequest) {
  return (await request.json()) as T;
}

export async function requireRoutePermissions(options: RoutePermissionOptions = {}) {
  const session = await auth();
  if (!session) {
    return apiError("Unauthorized", { status: 401 });
  }

  const access = await getSessionRBACContext(session, options.ttlSeconds ?? 60);

  if (options.any?.length && !hasAnySessionPermission(access, [...options.any])) {
    return apiError("Forbidden", { status: 403 });
  }

  if (options.all?.length && !options.all.every((permission) => hasSessionPermission(access, permission))) {
    return apiError("Forbidden", { status: 403 });
  }

  return session;
}

export function routeErrorResponse(error: unknown, fallback = "Internal error", status = 500) {
  const message = safeError(error);
  return apiError(message || fallback, { status });
}

// Next.js 15+ passes params as Promise<any>; must extend { params: Promise<any> } to satisfy route type checks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteContext = { params: Promise<any> };
type RouteHandler = (
  req: NextRequest,
  session: Session,
  access: SessionRBACContext,
  ctx: RouteContext,
) => Promise<NextResponse | Response>;

/**
 * Wraps a route handler with auth + optional RBAC check.
 * Eliminates the auth/permission boilerplate from every handler.
 *
 * Permission can be:
 *  - a single Permission string → must have that permission
 *  - an array → must have ANY of those permissions
 *  - null → auth-only (no permission check, useful for self-service routes)
 *
 * Usage:
 *   export const GET = withRoute("cluster:read", async (req, session) => { ... });
 *   export const POST = withRoute(["apps:write", "catalog:write"], async (req, session) => { ... });
 *   export const PATCH = withRoute(null, async (req, session) => { ... }); // auth-only
 */
export function withRoute(
  permission: Permission | Permission[] | null,
  handler: RouteHandler,
): (req: NextRequest, ctx: RouteContext) => Promise<NextResponse | Response> {
  return async (req: NextRequest, ctx: RouteContext = {} as RouteContext) => {
    const session = await auth();
    if (!session) return apiError("Unauthorized", { status: 401 });

    const access = await getSessionRBACContext(session, 60);

    if (permission !== null) {
      const perms = Array.isArray(permission) ? permission : [permission];
      if (!hasAnySessionPermission(access, perms)) {
        return apiError("Forbidden", { status: 403 });
      }
    }

    try {
      return await handler(req, session, access, ctx);
    } catch (error) {
      return routeErrorResponse(error);
    }
  };
}
