import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import {
  apiError,
  apiSuccess,
  parseJsonBody,
  requireRoutePermissions,
  routeErrorResponse,
} from "@/lib/route-utils";
import { refreshSpecialists } from "@/lib/feedback-automation";
import { isFeedbackHost } from "@/lib/feedback-host";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

// POST /api/feedback/automation/specialists/refresh — rebuild the library from a
// public GitHub repo of agent prompts (defaults to the dispatch service's repo).
export async function POST(request: NextRequest) {
  if (!isFeedbackHost(request.headers)) {
    return apiError("Agent Studio is only available on the canonical console host", { status: 403 });
  }
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  try {
    const body = await parseJsonBody<{ repo?: string }>(request).catch(() => ({}) as { repo?: string });
    const result = await refreshSpecialists(body?.repo);
    if (!result.ok) {
      return apiError(result.error ?? "Refresh failed", { status: 502 });
    }
    return apiSuccess({ library: result.data });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
