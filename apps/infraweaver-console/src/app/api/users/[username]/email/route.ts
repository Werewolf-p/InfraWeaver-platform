import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch } from "@/lib/authentik";
import { parseBody, withRoute } from "@/lib/route-utils";
import { bestEffortUsersConfigUpdate, resolvePrivilegedUserTarget, sessionActor } from "@/lib/user-guards";

const emailPatchSchema = z.object({
  newEmail: z.string().email(),
});

// C3: the email address is the destination of Authentik's password-recovery
// flow, so changing it is a privileged account-recovery action — require the
// higher users:write / rbac:admin gate, not the low-privilege users:invite.
export const PATCH = withRoute(["users:write", "rbac:admin"], async (req: NextRequest, session, access, ctx) => {
  const body = await parseBody(req, emailPatchSchema);
  if (body instanceof NextResponse) return body;
  const { newEmail } = body;

  const { username } = (await ctx.params) as { username: string };
  const user = await resolvePrivilegedUserTarget(access, username);
  if (user instanceof NextResponse) return user;

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ email: newEmail }),
  });
  if (!r.ok) return NextResponse.json({ error: "Authentik update failed" }, { status: 502 });

  // Non-fatal on failure: Authentik is already updated.
  await bestEffortUsersConfigUpdate((users) => {
    if (!users[username]) return false;
    users[username].email = newEmail;
    return true;
  }, `chore: update email for ${username}`);

  await auditLog("users:change-email", sessionActor(session), `Changed email for ${username} to ${newEmail}`);
  return NextResponse.json({ ok: true });
});
