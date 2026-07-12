import { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import type { SessionRBACContext } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { isRetryableInfraError } from "@/lib/retryable-error";
import { logMutatingAccess } from "@/lib/access-log";
import { getRequestClusterId } from "@/lib/cluster-context";

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

function safeClusterId(req: NextRequest): string | undefined {
  try {
    return getRequestClusterId(req);
  } catch {
    return undefined;
  }
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

  if (options.any?.length && !hasAnySessionPermission(access, options.any as Permission[])) {
    return apiError("Forbidden", { status: 403 });
  }

  if (options.all?.length && !options.all.every((permission) => hasSessionPermission(access, permission))) {
    return apiError("Forbidden", { status: 403 });
  }

  return session;
}

export function routeErrorResponse(error: unknown, fallback = "Internal error", status = 500) {
  const message = safeError(error);
  // Promote transient infra blips to a retryable 503 so the client can absorb
  // them; never override an explicit non-default status the caller passed.
  const resolvedStatus = status === 500 && isRetryableInfraError(error) ? 503 : status;
  return apiError(message || fallback, { status: resolvedStatus });
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
    const startedAt = Date.now();
    const session = await auth();
    if (!session) {
      logMutatingAccess(req, "unauthenticated", { status: 401, durationMs: Date.now() - startedAt });
      return apiError("Unauthorized", { status: 401 });
    }

    const actor = session.user?.email ?? "unknown";
    const clusterId = safeClusterId(req);
    const access = await getSessionRBACContext(session, 60);

    if (permission !== null) {
      const perms = Array.isArray(permission) ? permission : [permission];
      if (!hasAnySessionPermission(access, perms)) {
        logMutatingAccess(req, actor, { clusterId, status: 403, durationMs: Date.now() - startedAt });
        return apiError("Forbidden", { status: 403 });
      }
    }

    let response: NextResponse | Response;
    try {
      response = await handler(req, session, access, ctx);
    } catch (error) {
      response = routeErrorResponse(error);
    }
    logMutatingAccess(req, actor, { clusterId, status: response.status, durationMs: Date.now() - startedAt });
    return response;
  };
}

// ─── Shared route guards (additive helpers — adopt in routes incrementally) ──

/**
 * Parse + validate a JSON body against a zod schema. Returns the parsed value,
 * or the canonical 400 used across routes:
 *   { error: "Validation failed", details: <flattened zod error> }
 *
 * Usage:
 *   const body = await parseBody(req, schema);
 *   if (body instanceof NextResponse) return body;
 */
export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T | NextResponse> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  return parsed.data;
}

/** Canonical message rejected cluster-scoped mutations use when "all clusters" is active. */
export const SELECT_SPECIFIC_CLUSTER_MESSAGE = "Select a specific cluster before performing this action";

/**
 * Resolve the request's cluster and reject the "all clusters" pseudo-cluster
 * with the canonical 400 used by cluster-scoped mutating routes.
 *
 * Usage:
 *   const cluster = requireSingleCluster(req);
 *   if (cluster instanceof NextResponse) return cluster;
 *   const { clusterId } = cluster;
 */
export function requireSingleCluster(
  req: NextRequest,
  message: string = SELECT_SPECIFIC_CLUSTER_MESSAGE,
): { clusterId: string } | NextResponse {
  const clusterId = getRequestClusterId(req);
  if (clusterId === "all") {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return { clusterId };
}
