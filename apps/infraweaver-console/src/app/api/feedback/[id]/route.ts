import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import {
  updateFeedbackStatus,
  listFeedback,
  FEEDBACK_STATUSES,
  type FeedbackStatus,
} from "@/lib/feedback-store";
import { isDispatchConfigured, type ValidationAction } from "@/lib/feedback-dispatch";
import { startApprove, startRedo, acceptVerdict } from "@/lib/feedback-pipeline";
import { isFeedbackHost } from "@/lib/feedback-host";

// Approving / dispatching / resolving feedback is an admin-gated action.
// Human-in-the-loop: nothing downstream runs until an admin moves an entry to
// `approved`. This mirrors the cluster:admin gate used by agent approval.
const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

const VALIDATION_ACTIONS: ValidationAction[] = ["validated", "not_fixed"];

interface UpdateStatusBody {
  status?: string;
  reviewNote?: string;
  /** Reviewer verdict after testing the cluster preview (mutually exclusive with `status`). */
  action?: ValidationAction;
}

async function findEntry(id: string) {
  const entries = await listFeedback();
  return entries.find((e) => e.id === id) ?? null;
}

// PATCH /api/feedback/:id — change an entry's review status, OR record the
// reviewer's validate/not-fixed verdict (admin-gated, canonical-host only).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Domain gate: the review surface only acts on the canonical console host, so
  // approving/publishing can never be triggered from inside a preview deployment.
  if (!isFeedbackHost(request.headers)) {
    return apiError("Feedback review is only available on the canonical console host", { status: 403 });
  }

  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as UpdateStatusBody;
    const actor = session.user?.email ?? "unknown";
    const note = body.reviewNote;

    // Reviewer verdict on a dispatched entry after testing the preview.
    if (body.action) {
      if (!VALIDATION_ACTIONS.includes(body.action)) return apiError("Invalid action", { status: 400 });
      const entry = await findEntry(id);
      if (!entry) return apiError("Feedback entry not found", { status: 404 });

      if (body.action === "validated") {
        // Quick path: keep the commit on staging, mark accepted (awaiting publish).
        await acceptVerdict(entry, actor, note);
        const updated = await findEntry(id);
        return apiSuccess({ entry: updated, action: "validated", dispatchConfigured: isDispatchConfigured() });
      }

      // not_fixed: revert + re-run the cycle with the note. LONG — fire in the
      // background and stream progress; flip the entry back to a running state.
      const re = await updateFeedbackStatus(id, "approved", actor, note);
      if (!re) return apiError("Feedback entry not found", { status: 404 });
      if (isDispatchConfigured()) startRedo(re, (note ?? "").trim() || "(no note)");
      return apiSuccess({ entry: re, action: "not_fixed", started: isDispatchConfigured() });
    }

    const status = body.status as FeedbackStatus;
    if (!FEEDBACK_STATUSES.includes(status)) return apiError("Invalid status", { status: 400 });

    const entry = await updateFeedbackStatus(id, status, actor, note);
    if (!entry) return apiError("Feedback entry not found", { status: 404 });

    // Approving hands the entry straight to the dispatch service (plan →
    // validate → implement → build → preview). LONG — fire in the background;
    // the dashboard streams the live run and the preview URL is reconciled when
    // the run completes. Fail-safe: if DISPATCH_URL is unset we report skipped.
    if (status === "approved") {
      if (!isDispatchConfigured()) {
        return apiSuccess({ entry, dispatch: { ok: false, skipped: true } });
      }
      startApprove(entry);
      return apiSuccess({ entry, dispatch: { ok: true, started: true } });
    }

    return apiSuccess({ entry });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
