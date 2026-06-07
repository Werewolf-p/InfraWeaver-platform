import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { listFeedbackRuns } from "@/lib/feedback-dispatch";
import { isFeedbackHost } from "@/lib/feedback-host";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

// GET /api/feedback/:id/runs — dispatch run history for an entry (audit log).
// Server-side proxy: the dispatch service is cluster/runner-internal only.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isFeedbackHost(request.headers)) {
    return apiError("Run history is only available on the canonical console host", { status: 403 });
  }
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  const { id } = await params;
  try {
    const runs = await listFeedbackRuns(id);
    return apiSuccess({ runs });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
