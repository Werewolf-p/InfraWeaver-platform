import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";

const emailPatchSchema = z.object({
  newEmail: z.string().email(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  // C3: the email address is the destination of Authentik's password-recovery
  // flow, so changing it is a privileged account-recovery action — require the
  // higher users:write / rbac:admin gate, not the low-privilege users:invite.
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username } = await params;
  const rawBody = await req.json().catch(() => ({}));
  const parsed = emailPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { newEmail } = parsed.data;

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  // C3: privilege-ceiling — a non-rbac:admin operator must not be able to
  // redirect a superuser/admin account's recovery email and take it over.
  const targetIsSuperuser = (user as { is_superuser?: boolean }).is_superuser === true;
  if (targetIsSuperuser && !hasSessionPermission(access, "rbac:admin")) {
    return NextResponse.json({ error: "Forbidden: target account requires rbac:admin" }, { status: 403 });
  }

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ email: newEmail }),
  });
  if (!r.ok) return NextResponse.json({ error: "Authentik update failed" }, { status: 502 });

  try {
    const { users, sha } = await loadUsersConfig();
    if (users[username]) {
      users[username].email = newEmail;
      await saveUsersConfig(users, sha, `chore: update email for ${username}`);
    }
  } catch {
    // Non-fatal: Authentik already updated
  }

  await auditLog("users:change-email", session.user?.email ?? "unknown", `Changed email for ${username} to ${newEmail}`);
  return NextResponse.json({ ok: true });
}
