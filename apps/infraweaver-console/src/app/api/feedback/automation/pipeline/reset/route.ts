import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { resetPipeline } from "@/lib/feedback-automation";
import { isFeedbackHost } from "@/lib/feedback-host";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

// POST /api/feedback/automation/pipeline/reset — restore the default pipeline.
export async function POST(request: NextRequest) {
  if (!isFeedbackHost(request.headers)) {
    return apiError("Agent Studio is only available on the canonical console host", { status: 403 });
  }
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  try {
    const result = await resetPipeline();
    if (!result.ok) {
      return apiError(result.error ?? "Failed to reset", { status: 400 });
    }
    return apiSuccess({ pipeline: result.data });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
