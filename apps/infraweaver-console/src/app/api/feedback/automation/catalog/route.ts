import { NextRequest } from "next/server";
import { apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { getCatalog } from "@/lib/feedback-automation";
import { requireFeedbackManager } from "@/lib/feedback-host";

// GET /api/feedback/automation/catalog — option catalogs for the Agent Studio editor.
export async function GET(request: NextRequest) {
  const session = await requireFeedbackManager(request, "Agent Studio is only available on the canonical console host");
  if (session instanceof Response) return session;

  try {
    const catalog = await getCatalog();
    return apiSuccess({ catalog });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
