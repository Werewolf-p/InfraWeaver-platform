import { NextRequest } from "next/server";
import { apiError, apiSuccess, parseJsonBody, routeErrorResponse } from "@/lib/route-utils";
import { refreshSpecialists } from "@/lib/feedback-automation";
import { requireFeedbackManager } from "@/lib/feedback-host";

// POST /api/feedback/automation/specialists/refresh — rebuild the library from a
// public GitHub repo of agent prompts (defaults to the dispatch service's repo).
export async function POST(request: NextRequest) {
  const session = await requireFeedbackManager(request, "Agent Studio is only available on the canonical console host");
  if (session instanceof Response) return session;

  try {
    const body = await parseJsonBody<{ repo?: string }>(request).catch(() => ({}) as { repo?: string });
    const repo = body?.repo;
    // Validate at this boundary before forwarding to the dispatch service: the
    // value must be a plain `owner/name` GitHub slug, never a URL or shell text.
    if (repo !== undefined && (typeof repo !== "string" || repo.length > 140 || !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
      return apiError("Invalid repo — expected owner/name", { status: 400 });
    }
    const result = await refreshSpecialists(repo);
    if (!result.ok) {
      return apiError(result.error ?? "Refresh failed", { status: 502 });
    }
    return apiSuccess({ library: result.data });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
