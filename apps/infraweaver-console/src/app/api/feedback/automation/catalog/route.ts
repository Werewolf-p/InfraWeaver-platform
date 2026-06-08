import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getCatalog } from "@/lib/feedback-automation";
import { isFeedbackHost } from "@/lib/feedback-host";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

// GET /api/feedback/automation/catalog — option catalogs for the Agent Studio editor.
export async function GET(request: NextRequest) {
  if (!isFeedbackHost(request.headers)) {
    return apiError("Agent Studio is only available on the canonical console host", { status: 403 });
  }
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  try {
    const catalog = await getCatalog();
    return apiSuccess({ catalog });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
