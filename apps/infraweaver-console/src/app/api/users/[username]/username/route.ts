import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";

const USERNAME_RE = /^[a-z0-9.-]{3,32}$/;
const usernamePatchSchema = z.object({
  newUsername: z.string().regex(USERNAME_RE, "Must be 3-32 chars, a-z0-9.-"),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username } = await params;
  const rawBody = await req.json().catch(() => ({}));
  const parsed = usernamePatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { newUsername } = parsed.data;

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const selfEmail = (session.user as { email?: string }).email ?? "";
  if (user.email === selfEmail) {
    return NextResponse.json({ error: "Cannot rename yourself" }, { status: 400 });
  }

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ username: newUsername }),
  });
  if (!r.ok) return NextResponse.json({ error: "Authentik update failed" }, { status: 502 });

  try {
    const { users, sha } = await loadUsersConfig();
    if (users[username]) {
      const userData = users[username];
      delete users[username];
      users[newUsername] = userData;
      await saveUsersConfig(users, sha, `chore: rename user ${username} → ${newUsername}`);
    }
  } catch {
    // Non-fatal
  }

  await auditLog(
    "users:change-username",
    session.user?.email ?? "unknown",
    `Renamed ${username} to ${newUsername}`
  );
  return NextResponse.json({ ok: true });
}
