import { NextRequest } from "next/server";
import { apiError, apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { getFeedbackRunLog } from "@/lib/feedback-dispatch";
import { requireFeedbackManager } from "@/lib/feedback-host";

// GET /api/feedback/:id/runs/:runId/log — full transcript for one run (audit).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const session = await requireFeedbackManager(request, "Run logs are only available on the canonical console host");
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
