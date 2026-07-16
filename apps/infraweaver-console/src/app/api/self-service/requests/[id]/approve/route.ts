import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auditLog } from "@/lib/audit-log";
import { withRoute } from "@/lib/route-utils";
import { hasSessionPermission, type SessionRBACContext } from "@/lib/session-rbac";
import { getRequest, updateRequestStatus } from "@/lib/self-service/store";
import { executeRequest } from "@/lib/self-service/apply";
import { notifyDecision } from "@/lib/self-service/notify";
import { isPendingStatus } from "@/lib/self-service/types";

/** Admin gate for approve/deny — any of these permissions may act on the queue. */
const ADMIN_PERMS = ["users:write", "rbac:admin", "cluster:admin"] as const;

function actorOf(session: Session): string {
  return session.user?.email ?? "unknown";
}

/**
 * POST — approve a pending request and APPLY it under the APPROVER's ceiling.
 *
 * app-access flows through applyRoleAssignments with the approver's
 * granterPermsAt, so a role that exceeds the approver returns the choke point's
 * 403 unchanged (the request is marked failed, never over-granted). storage-quota
 * additionally requires `cluster:admin` specifically, matching the PVC-patch
 * primitive. Escalation only ever happens with real admin authority.
 */
export const POST = withRoute([...ADMIN_PERMS], async (req: NextRequest, session, access: SessionRBACContext, ctx) => {
  const { id } = (await ctx.params) as { id: string };
  const request = await getRequest(id);
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPendingStatus(request.status)) {
    return NextResponse.json({ error: "Request is not pending" }, { status: 409 });
  }

  const actor = actorOf(session);

  // storage-quota's apply primitive is cluster:admin-only — enforce it specifically.
  if (request.type === "storage-quota" && !hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Storage quota approval requires cluster:admin" }, { status: 403 });
  }

  const outcome = await executeRequest(request, { actorCtx: access, actor });
  if (!outcome.ok) {
    await updateRequestStatus(id, {
      status: "failed",
      decidedBy: actor,
      decidedAt: new Date().toISOString(),
      decisionNote: outcome.error,
      appliedSummary: outcome.error,
    });
    await auditLog("self-service:apply-failed", actor, `Approval apply failed for ${request.type}: ${outcome.error}`, {
      resource: "self-service",
      req,
      result: "failure",
    });
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  const approved = await updateRequestStatus(id, {
    status: "approved",
    decidedBy: actor,
    decidedAt: new Date().toISOString(),
    appliedSummary: outcome.summary,
  });
  await auditLog("self-service:approve", actor, `Approved ${request.type} for ${request.requestedBy}: ${outcome.summary}`, {
    resource: "self-service",
    req,
  });
  if (approved) void notifyDecision(approved);

  // Recovery link (should not occur on the approval path) is returned once, never persisted.
  return NextResponse.json({ request: approved, ...(outcome.recoveryLink ? { recoveryLink: outcome.recoveryLink } : {}) });
});
