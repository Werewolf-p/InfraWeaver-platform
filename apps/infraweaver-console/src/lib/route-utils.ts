import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
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
