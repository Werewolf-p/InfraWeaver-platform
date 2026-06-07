import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { updateFeedbackStatus, FEEDBACK_STATUSES, type FeedbackStatus } from "@/lib/feedback-store";
import {
  dispatchApprovedFeedback,
  validateFeedback,
  type DispatchResult,
  type ValidationAction,
} from "@/lib/feedback-dispatch";

// Approving / dispatching / resolving feedback is an admin-gated action.
// Human-in-the-loop: nothing downstream runs until an admin moves an entry to
// `approved`. This mirrors the cluster:admin gate used by agent approval.
const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

const VALIDATION_ACTIONS: ValidationAction[] = ["validated", "not_fixed"];

interface UpdateStatusBody {
  status?: string;
  reviewNote?: string;
  /** Preview deployment URL written back by the n8n fix-flow. */
  previewUrl?: string;
  /** Reviewer verdict after testing the cluster preview (mutually exclusive with `status`). */
  action?: ValidationAction;
}

// PATCH /api/feedback/:id — change an entry's review status, OR record the
// reviewer's validate/not-fixed verdict on a dispatched entry (admin-gated).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as UpdateStatusBody;
    const actor = session.user?.email ?? "unknown";

    // Validation verdict: reviewer tested the preview and clicked Validated /
    // Not fixed. The entry stays `dispatched`; the n8n validate-flow writes the
    // final status back (done on promote, or a fresh dispatch on not_fixed).
    if (body.action) {
      if (!VALIDATION_ACTIONS.includes(body.action)) return apiError("Invalid action", { status: 400 });
      const entry = await updateFeedbackStatus(id, "dispatched", actor, body.reviewNote);
      if (!entry) return apiError("Feedback entry not found", { status: 404 });
      const validate = await validateFeedback(entry, body.action, body.reviewNote);
      return apiSuccess({ entry, validate });
    }

    const status = body.status as FeedbackStatus;
    if (!FEEDBACK_STATUSES.includes(status)) return apiError("Invalid status", { status: 400 });

    const entry = await updateFeedbackStatus(id, status, actor, body.reviewNote, {
      previewUrl: body.previewUrl,
    });
    if (!entry) return apiError("Feedback entry not found", { status: 404 });

    // One-flow: approving hands the entry straight to Claude via the n8n
    // dev-feedback-fix-flow webhook. Fail-safe — the approval is already
    // persisted, so a dispatch failure is reported but never lost.
    let dispatch: DispatchResult | undefined;
    if (status === "approved") {
      dispatch = await dispatchApprovedFeedback(entry);
    }
    return apiSuccess({ entry, dispatch });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
