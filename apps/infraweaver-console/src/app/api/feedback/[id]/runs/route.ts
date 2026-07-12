import { NextRequest } from "next/server";
import { apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { listFeedbackRuns } from "@/lib/feedback-dispatch";
import { requireFeedbackManager } from "@/lib/feedback-host";

// GET /api/feedback/:id/runs — dispatch run history for an entry (audit log).
// Server-side proxy: the dispatch service is cluster/runner-internal only.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeedbackManager(request, "Run history is only available on the canonical console host");
  if (session instanceof Response) return session;

  const { id } = await params;
  try {
    const runs = await listFeedbackRuns(id);
    return apiSuccess({ runs });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
