import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getFeedbackRunLog } from "@/lib/feedback-dispatch";
import { isFeedbackHost } from "@/lib/feedback-host";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

// GET /api/feedback/:id/runs/:runId/log — full transcript for one run (audit).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  if (!isFeedbackHost(request.headers)) {
    return apiError("Run logs are only available on the canonical console host", { status: 403 });
  }
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  const { runId } = await params;
  try {
    const result = await getFeedbackRunLog(runId);
    if (!result) return apiError("Run not found", { status: 404 });
    return apiSuccess(result);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
