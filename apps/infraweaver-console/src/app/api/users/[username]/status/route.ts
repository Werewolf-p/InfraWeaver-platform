import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch } from "@/lib/authentik";
import { parseBody, withRoute } from "@/lib/route-utils";
import { resolvePrivilegedUserTarget, sessionActor } from "@/lib/user-guards";

const statusBodySchema = z.object({
  active: z.boolean(),
}).strict();

// C3: enabling/disabling an account is a destructive lifecycle action
// (identical to offboard Step 1), so — like offboard and reset-password —
// users:invite is deliberately excluded: it is the low-privilege enrollment
// role and must never authorize account lockout/reactivation. The superuser
// privilege ceiling (resolvePrivilegedUserTarget) stops a non-rbac:admin
// operator from disabling (or re-enabling) a superuser/admin account.
export const PATCH = withRoute(["users:write", "rbac:admin"], async (req: NextRequest, session, access, ctx) => {
  const body = await parseBody(req, statusBodySchema);
  if (body instanceof NextResponse) return body;
  const { active } = body;

  const { username } = (await ctx.params) as { username: string };
  const user = await resolvePrivilegedUserTarget(access, username);
  if (user instanceof NextResponse) return user;

  const selfEmail = (session.user as { email?: string }).email ?? "";
  if (user.email === selfEmail) {
    return NextResponse.json({ error: "Cannot change your own status" }, { status: 400 });
  }

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: active }),
  });
  if (!r.ok) return NextResponse.json({ error: "Authentik update failed" }, { status: 502 });

  await auditLog(
    `users:${active ? "enable" : "disable"}`,
    sessionActor(session),
    `Set is_active=${active} for ${username}`
  );
  return NextResponse.json({ ok: true });
});
