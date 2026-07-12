import { NextRequest } from "next/server";
import { apiError, apiSuccess, parseJsonBody, routeErrorResponse } from "@/lib/route-utils";
import { getPipeline, savePipeline } from "@/lib/feedback-automation";
import { requireFeedbackManager } from "@/lib/feedback-host";

// GET /api/feedback/automation/pipeline — current auto-fix pipeline definition.
export async function GET(request: NextRequest) {
  const session = await requireFeedbackManager(request, "Agent Studio is only available on the canonical console host");
  if (session instanceof Response) return session;

  try {
    const pipeline = await getPipeline();
    return apiSuccess({ pipeline });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

// PUT /api/feedback/automation/pipeline — save an edited pipeline.
export async function PUT(request: NextRequest) {
  const session = await requireFeedbackManager(request, "Agent Studio is only available on the canonical console host");
  if (session instanceof Response) return session;

  try {
    const body = await parseJsonBody(request);
    const result = await savePipeline(body);
    if (!result.ok) {
      return apiError(result.error ?? "Failed to save pipeline", { status: 400 });
    }
    return apiSuccess({ pipeline: result.data });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
