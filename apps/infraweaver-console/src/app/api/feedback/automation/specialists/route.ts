import { NextRequest } from "next/server";
import { apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { getSpecialists } from "@/lib/feedback-automation";
import { requireFeedbackManager } from "@/lib/feedback-host";

// GET /api/feedback/automation/specialists — the specialist-prompt library.
export async function GET(request: NextRequest) {
  const session = await requireFeedbackManager(request, "Agent Studio is only available on the canonical console host");
  if (session instanceof Response) return session;

  try {
    const library = await getSpecialists();
    return apiSuccess({ library });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
