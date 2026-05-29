import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import {
  createFeedback,
  listFeedback,
  FEEDBACK_TYPES,
  FEEDBACK_SEVERITIES,
  type FeedbackSeverity,
  type FeedbackType,
} from "@/lib/feedback-store";

// Any authenticated user may submit/list feedback context.
const SUBMIT: Permission[] = ["apps:read", "cluster:read"];

// GET /api/feedback — list collected feedback entries (auth-gated).
export async function GET() {
  const session = await requireRoutePermissions({ any: SUBMIT });
  if (session instanceof Response) return session;
  try {
    const entries = await listFeedback();
    return apiSuccess({ entries });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

interface CreateFeedbackBody {
  description?: string;
  type?: string;
  pagePath?: string;
  severity?: string;
}

// POST /api/feedback — capture a new feedback entry (auth-gated).
export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ any: SUBMIT });
  if (session instanceof Response) return session;
  try {
    const body = (await request.json().catch(() => ({}))) as CreateFeedbackBody;
    const description = body.description?.trim();
    const type = body.type as FeedbackType;
    const pagePath = body.pagePath?.trim();
    const severity = body.severity as FeedbackSeverity | undefined;

    if (!description) return apiError("description is required", { status: 400 });
    if (description.length > 4000) return apiError("description too long", { status: 400 });
    if (!FEEDBACK_TYPES.includes(type)) return apiError("Invalid feedback type", { status: 400 });
    if (!pagePath) return apiError("pagePath is required", { status: 400 });
    if (severity !== undefined && !FEEDBACK_SEVERITIES.includes(severity)) {
      return apiError("Invalid severity", { status: 400 });
    }

    const actor = session.user?.email ?? "unknown";
    const entry = await createFeedback({ description, type, pagePath, severity }, actor);
    return apiSuccess({ entry }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
