import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { updateFeedbackStatus, FEEDBACK_STATUSES, type FeedbackStatus } from "@/lib/feedback-store";

// Approving / dispatching / resolving feedback is an admin-gated action.
// Human-in-the-loop: nothing downstream runs until an admin moves an entry to
// `approved`. This mirrors the cluster:admin gate used by agent approval.
const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

interface UpdateStatusBody {
  status?: string;
  reviewNote?: string;
}

// PATCH /api/feedback/:id — change an entry's review status (admin-gated).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;

  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as UpdateStatusBody;
    const status = body.status as FeedbackStatus;
    if (!FEEDBACK_STATUSES.includes(status)) return apiError("Invalid status", { status: 400 });

    const actor = session.user?.email ?? "unknown";
    const entry = await updateFeedbackStatus(id, status, actor, body.reviewNote);
    if (!entry) return apiError("Feedback entry not found", { status: 404 });
    return apiSuccess({ entry });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
