import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { withRoute } from "@/lib/route-utils";
import type { SessionRBACContext } from "@/lib/session-rbac";
import { getRequest, updateRequestStatus } from "@/lib/self-service/store";
import { notifyDecision } from "@/lib/self-service/notify";
import { isPendingStatus } from "@/lib/self-service/types";

const ADMIN_PERMS = ["users:write", "rbac:admin", "cluster:admin"] as const;

const denySchema = z.object({ note: z.string().trim().min(1).max(500) });

function actorOf(session: Session): string {
  return session.user?.email ?? "unknown";
}

/** POST — deny a pending request. A denial note is required. */
export const POST = withRoute([...ADMIN_PERMS], async (req: NextRequest, session, _access: SessionRBACContext, ctx) => {
  const { id } = (await ctx.params) as { id: string };
  const request = await getRequest(id);
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPendingStatus(request.status)) {
    return NextResponse.json({ error: "Request is not pending" }, { status: 409 });
  }

  const parsed = denySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A denial note is required", details: parsed.error.flatten() }, { status: 400 });
  }

  const actor = actorOf(session);
  const denied = await updateRequestStatus(id, {
    status: "denied",
    decidedBy: actor,
    decidedAt: new Date().toISOString(),
    decisionNote: parsed.data.note,
  });
  await auditLog("self-service:deny", actor, `Denied ${request.type} for ${request.requestedBy}: ${parsed.data.note}`, {
    resource: "self-service",
    req,
  });
  if (denied) void notifyDecision(denied);
  return NextResponse.json({ request: denied });
});
