import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch } from "@/lib/authentik";
import { parseBody, withRoute } from "@/lib/route-utils";
import { bestEffortUsersConfigUpdate, resolvePrivilegedUserTarget, sessionActor } from "@/lib/user-guards";

const USERNAME_RE = /^[a-z0-9.-]{3,32}$/;
const usernamePatchSchema = z.object({
  newUsername: z.string().regex(USERNAME_RE, "Must be 3-32 chars, a-z0-9.-"),
});

// C3: renaming rewrites the users.yaml key that role assignments and session
// identity are keyed on — a privileged lifecycle mutation. Require the higher
// users:write / rbac:admin gate, not the low-privilege users:invite.
export const PATCH = withRoute(["users:write", "rbac:admin"], async (req: NextRequest, session, access, ctx) => {
  const body = await parseBody(req, usernamePatchSchema);
  if (body instanceof NextResponse) return body;
  const { newUsername } = body;

  const { username } = (await ctx.params) as { username: string };
  const user = await resolvePrivilegedUserTarget(access, username);
  if (user instanceof NextResponse) return user;

  const selfEmail = (session.user as { email?: string }).email ?? "";
  if (user.email === selfEmail) {
    return NextResponse.json({ error: "Cannot rename yourself" }, { status: 400 });
  }

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ username: newUsername }),
  });
  if (!r.ok) return NextResponse.json({ error: "Authentik update failed" }, { status: 502 });

  // Non-fatal on failure: Authentik is already updated.
  await bestEffortUsersConfigUpdate((users) => {
    if (!users[username]) return false;
    const userData = users[username];
    delete users[username];
    users[newUsername] = userData;
    return true;
  }, `chore: rename user ${username} → ${newUsername}`);

  await auditLog(
    "users:change-username",
    sessionActor(session),
    `Renamed ${username} to ${newUsername}`
  );
  return NextResponse.json({ ok: true });
});
