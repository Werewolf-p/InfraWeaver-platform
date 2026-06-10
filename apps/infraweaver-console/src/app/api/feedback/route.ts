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
import { isDispatchConfigured } from "@/lib/feedback-dispatch";
import { needsReconcile, reconcileStaleEntries } from "@/lib/feedback-pipeline";

// Any authenticated user may submit/list feedback context.
const SUBMIT: Permission[] = ["apps:read", "cluster:read"];

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE INTENTIONALLY-HARDCODED VALUE IN INFRAWEAVER.
//
// Every forked deployment reports user feedback back to the canonical
// InfraWeaver endpoint so the maintainers can keep improving the platform for
// all forks. This is deliberately a constant and is NOT environment-overridable
// Canonical feedback endpoint. Override per-deployment via the FEEDBACK_URL
// env var; the generic default keeps the public template free of real domains.
const FEEDBACK_URL = process.env.FEEDBACK_URL || "https://infraweaver.example.com/api/feedback";

// Marks a request that is an already-forwarded ("upstream") copy. It serves two
// purposes: (1) loop guard — the canonical deployment receiving forwarded
// feedback must NOT forward it again; (2) it is the auth-bypass path used to
// ingest anonymous cross-deployment feedback (header-gated, minimal fields only).
const UPSTREAM_HEADER = "x-infraweaver-upstream";

// Fire-and-forward a sanitized copy of a feedback entry to the canonical
// endpoint. Non-blocking and failure-swallowing: it must never affect the local
// user's response or throw into the request path.
function forwardToCanonical(payload: {
  description: string;
  type: FeedbackType;
  pagePath: string;
  severity?: FeedbackSeverity;
}) {
  void fetch(FEEDBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", [UPSTREAM_HEADER]: "1" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Intentionally ignored — upstream reporting is best-effort.
  });
}

// GET /api/feedback — list collected feedback entries (auth-gated).
export async function GET() {
  const session = await requireRoutePermissions({ any: SUBMIT });
  if (session instanceof Response) return session;
  try {
    let entries = await listFeedback();
    // Self-heal entries stranded mid-run by a console restart (`approved` with no
    // write-back, or `dispatched` with no preview URL), so the dashboard reflects
    // finished dispatch runs and backfills their preview URLs without manual
    // intervention.
    if (isDispatchConfigured() && entries.some(needsReconcile)) {
      await reconcileStaleEntries(entries);
      entries = await listFeedback();
    }
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

// POST /api/feedback — capture a new feedback entry.
//
// Two paths:
//  • Normal user (auth-gated): store locally, then fire-and-forward a copy to the
//    canonical InfraWeaver endpoint (FEEDBACK_URL).
//  • Upstream copy (carries UPSTREAM_HEADER): an anonymous cross-deployment
//    submission forwarded from another fork. Auth is bypassed (it has no session)
//    and it is NOT forwarded again — the canonical deployment ingests it here.
export async function POST(request: NextRequest) {
  const isUpstream = request.headers.get(UPSTREAM_HEADER) === "1";

  let actor = "upstream-fork";
  if (!isUpstream) {
    const session = await requireRoutePermissions({ any: SUBMIT });
    if (session instanceof Response) return session;
    actor = session.user?.email ?? "unknown";
  }

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

    const entry = await createFeedback({ description, type, pagePath, severity }, actor);

    // Only original (locally-submitted) feedback is forwarded upstream; forwarded
    // copies are not re-forwarded (loop guard).
    if (!isUpstream) {
      forwardToCanonical({ description, type, pagePath, severity });
    }

    return apiSuccess({ entry }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
