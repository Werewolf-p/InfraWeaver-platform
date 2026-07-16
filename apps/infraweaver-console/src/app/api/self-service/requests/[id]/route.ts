import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auditLog } from "@/lib/audit-log";
import { withRoute } from "@/lib/route-utils";
import { hasAnySessionPermission, type SessionRBACContext } from "@/lib/session-rbac";
import { getRequest, updateRequestStatus } from "@/lib/self-service/store";
import { isPendingStatus } from "@/lib/self-service/types";

const ADMIN_PERMS = ["users:write", "rbac:admin", "cluster:admin"] as const;

function actorOf(session: Session): string {
  return session.user?.email ?? "unknown";
}

function ownsRequest(requestedBy: string, actor: string): boolean {
  return requestedBy.trim().toLowerCase() === actor.trim().toLowerCase();
}

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<string> {
  const params = await ctx.params;
  return params.id;
}

/** GET a single request — the owner, or any admin. */
export const GET = withRoute(null, async (_req: NextRequest, session, access: SessionRBACContext, ctx) => {
  const request = await getRequest(await paramId(ctx));
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const isAdmin = hasAnySessionPermission(access, [...ADMIN_PERMS]);
  if (!isAdmin && !ownsRequest(request.requestedBy, actorOf(session))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ request });
});

/** DELETE — cancel your OWN still-pending request. */
export const DELETE = withRoute(null, async (req: NextRequest, session, _access: SessionRBACContext, ctx) => {
  const id = await paramId(ctx);
  const request = await getRequest(id);
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const actor = actorOf(session);
  if (!ownsRequest(request.requestedBy, actor)) {
    return NextResponse.json({ error: "You can only cancel your own requests" }, { status: 403 });
  }
  if (!isPendingStatus(request.status)) {
    return NextResponse.json({ error: "Only a pending request can be cancelled" }, { status: 409 });
  }

  const updated = await updateRequestStatus(id, {
    status: "cancelled",
    decidedBy: actor,
    decidedAt: new Date().toISOString(),
    decisionNote: "Cancelled by requester",
  });
  await auditLog("self-service:cancel", actor, `Cancelled ${request.type} request`, { resource: "self-service", req });
  return NextResponse.json({ request: updated });
});
