/**
 * Audit middleware for Next.js API route handlers.
 *
 * Usage:
 *   export const POST = withAudit("resource:write", async (req) => { ... });
 *
 * Wraps a route handler and automatically logs write operations to the audit log.
 * Captures: timestamp, userId, action, resource, result (success/failure), ip, userAgent.
 */

import type { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";

type RouteHandler<TParams = unknown> = (
  req: NextRequest,
  ctx: TParams,
) => Promise<NextResponse> | NextResponse;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Wraps a route handler to automatically audit write operations.
 *
 * @param action  The audit action label (e.g. "cluster:restart-app")
 * @param handler The underlying route handler
 * @param options Optional resource type override
 */
export function withAudit<TParams = { params?: Promise<Record<string, string>> }>(
  action: string,
  handler: RouteHandler<TParams>,
  options: { resource?: string; alwaysAudit?: boolean } = {},
): RouteHandler<TParams> {
  return async (req: NextRequest, ctx: TParams): Promise<NextResponse> => {
    const isWrite = WRITE_METHODS.has(req.method);
    if (!isWrite && !options.alwaysAudit) {
      return handler(req, ctx);
    }

    const session = await auth();
    const userId = session?.user?.email ?? session?.user?.name ?? "anonymous";
    const resource = options.resource ?? new URL(req.url).pathname;
    const startedAt = Date.now();

    let response: NextResponse;
    try {
      response = await handler(req, ctx);
    } catch (err) {
      await auditLog(action, userId, `${req.method} ${resource} — exception: ${String(err)}`, {
        result: "failure",
        resource,
        req,
      });
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    const isSuccess = response.status < 400;

    await auditLog(
      action,
      userId,
      `${req.method} ${resource} — ${response.status} (${durationMs}ms)`,
      {
        result: isSuccess ? "success" : "failure",
        resource,
        req,
      },
    );

    return response;
  };
}
