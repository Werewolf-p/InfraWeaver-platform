import { NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import { hasAnySessionPermission, type SessionRBACContext } from "@/lib/session-rbac";
import { normalizeGroups } from "@/lib/rbac";
import type { Session } from "next-auth";
import {
  countOpenRequestsFor,
  createRequest,
  findPendingDuplicate,
  listPendingRequests,
  listRequestsFor,
} from "@/lib/self-service/store";
import { evaluateAutoApply, validateSubmittable } from "@/lib/self-service/evaluate";
import { executeRequest } from "@/lib/self-service/apply";
import { getOwnedPvcsForSession } from "@/lib/self-service/owned-pvcs";
import { describeRequest } from "@/lib/self-service/describe";
import { selfServiceSubmitSchema, type SelfServiceRequest } from "@/lib/self-service/types";

/** Permissions that let a caller view the full pending queue (?all=1) + approve/deny. */
const ADMIN_PERMS = ["users:write", "rbac:admin", "cluster:admin"] as const;
/** A single requester may hold at most this many still-pending requests. */
const MAX_OPEN_REQUESTS = 20;

function actorOf(session: Session): string {
  return session.user?.email ?? "unknown";
}

/**
 * GET — the caller's own requests. A caller holding an admin permission may pass
 * `?all=1` to list every pending request (the approval-queue feed).
 */
export const GET = withRoute(null, async (req: NextRequest, session, access: SessionRBACContext) => {
  const wantsAll = req.nextUrl.searchParams.get("all") === "1";
  if (wantsAll) {
    if (!hasAnySessionPermission(access, [...ADMIN_PERMS])) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ requests: await listPendingRequests() });
  }
  return NextResponse.json({ requests: await listRequestsFor(actorOf(session)) });
});

/**
 * POST — submit a self-service request. Rate-limited, validated at the boundary,
 * ceiling-bounded, then routed by evaluateAutoApply: auto-applied now under the
 * requester's own ceiling, or queued for admin approval. A self-request can never
 * self-escalate — see lib/self-service/evaluate.ts.
 */
export const POST = withRoute(null, async (req: NextRequest, session, access: SessionRBACContext) => {
  if (!checkRateLimit(rateLimitKey("self-service-submit", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = selfServiceSubmitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const actor = actorOf(session);
  const groups = normalizeGroups((session.user as { groups?: string[] } | undefined)?.groups);

  // A candidate request used for evaluate/validate before anything is persisted.
  const candidate: SelfServiceRequest = {
    id: "candidate",
    type: parsed.data.type,
    status: "pending",
    requestedBy: actor,
    requestedByGroups: groups,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    payload: parsed.data.payload as SelfServiceRequest["payload"],
    createdAt: new Date().toISOString(),
  };

  // Boundary check: cannot request storage quota on a volume that is not yours.
  const ownedPvcs = candidate.type === "storage-quota" ? await getOwnedPvcsForSession(session) : [];
  const submittable = validateSubmittable(access, candidate, ownedPvcs);
  if (!submittable.ok) {
    await auditLog("self-service:submit:denied", actor, `Rejected ${candidate.type} submission: ${submittable.error}`, {
      resource: "self-service",
      req,
      result: "failure",
    });
    return NextResponse.json({ error: submittable.error }, { status: submittable.status });
  }

  const decision = evaluateAutoApply(access, candidate);

  if (decision.autoApply) {
    // Apply now under the REQUESTER's own ceiling (applyRoleAssignments re-enforces it).
    const outcome = await executeRequest(candidate, { actorCtx: access, actor });
    if (!outcome.ok) {
      const failed = await createRequest({
        type: candidate.type,
        status: "failed",
        requestedBy: actor,
        requestedByGroups: groups,
        reason: candidate.reason,
        payload: candidate.payload,
        appliedSummary: outcome.error,
      });
      await auditLog("self-service:apply-failed", actor, `Auto-apply failed for ${candidate.type}: ${outcome.error}`, {
        resource: "self-service",
        req,
        result: "failure",
      });
      return NextResponse.json({ request: failed, error: outcome.error }, { status: outcome.status });
    }
    const applied = await createRequest({
      type: candidate.type,
      status: "auto-applied",
      requestedBy: actor,
      requestedByGroups: groups,
      reason: candidate.reason,
      payload: candidate.payload,
      appliedSummary: outcome.summary,
    });
    await auditLog("self-service:auto-apply", actor, `Auto-applied ${candidate.type}: ${outcome.summary}`, {
      resource: "self-service",
      req,
    });
    // Recovery link (password-reset) is returned once and never persisted.
    return NextResponse.json({ request: applied, ...(outcome.recoveryLink ? { recoveryLink: outcome.recoveryLink } : {}) }, { status: 201 });
  }

  // Queue for admin approval. Dedupe identical still-pending requests + cap open count.
  const duplicate = await findPendingDuplicate({ type: candidate.type, requestedBy: actor, payload: candidate.payload });
  if (duplicate) {
    return NextResponse.json({ request: duplicate, error: "A matching request is already pending" }, { status: 409 });
  }
  if ((await countOpenRequestsFor(actor)) >= MAX_OPEN_REQUESTS) {
    return NextResponse.json({ error: "You have too many open requests" }, { status: 429 });
  }

  const queued = await createRequest({
    type: candidate.type,
    status: "pending",
    requestedBy: actor,
    requestedByGroups: groups,
    reason: candidate.reason,
    payload: candidate.payload,
  });
  await auditLog("self-service:submit", actor, `Submitted ${candidate.type}: ${describeRequest(queued)} (${decision.reason})`, {
    resource: "self-service",
    req,
  });
  return NextResponse.json({ request: queued }, { status: 201 });
});
