import { NextRequest } from "next/server";
import { apiError, apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { countAcceptedFeedback } from "@/lib/feedback-store";
import { isDispatchConfigured } from "@/lib/feedback-dispatch";
import { startPublish } from "@/lib/feedback-pipeline";
import { requireFeedbackManager } from "@/lib/feedback-host";

// POST /api/feedback/publish — merge all accepted changes to main and release.
// Publishing drains feedback/staging → main and releases prod — the most
// privileged action in the pipeline. Admin-gated + canonical-host only.
export async function POST(request: NextRequest) {
  const session = await requireFeedbackManager(request, "Publish is only available on the canonical console host");
  if (session instanceof Response) return session;

  try {
    const accepted = await countAcceptedFeedback();
    if (accepted === 0) {
      return apiError("Nothing to publish — no accepted changes on the staging branch", { status: 409 });
    }
    if (!isDispatchConfigured()) {
      return apiSuccess({ ok: false, skipped: true, accepted });
    }

    const actor = session.user?.email ?? "unknown";
    // LONG — fire in the background; the dashboard streams the publish run
    // (feedbackId "publish") and accepted entries flip to done on success.
    startPublish(actor);
    return apiSuccess({ ok: true, started: true, accepted });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
