import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";

const ResetBody = z.object({
  username: z.string().min(1).max(150).regex(/^[\w.@+-]+$/, "Invalid username"),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  // C3: password reset is a privileged account-recovery action — require the
  // higher users:write / rbac:admin gate, not the low-privilege users:invite.
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = ResetBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { username } = parsed.data;

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  // C3: privilege-ceiling — a non-rbac:admin operator must not be able to reset
  // the credentials of a superuser/admin account and take it over.
  const targetIsSuperuser = (user as { is_superuser?: boolean }).is_superuser === true;
  if (targetIsSuperuser && !hasSessionPermission(access, "rbac:admin")) {
    return NextResponse.json({ error: "Forbidden: target account requires rbac:admin" }, { status: 403 });
  }

  // C3: do NOT generate or return a plaintext password. Use Authentik's recovery
  // flow so the user sets their own password through a verified recovery link.
  const r = await authentikFetch(`/core/users/${user.pk}/recovery/`, { method: "POST" });
  if (!r.ok) {
    // Do not reflect Authentik's raw error body to the client.
    return NextResponse.json({ error: "Failed to start password recovery" }, { status: 502 });
  }
  const data = (await r.json().catch(() => ({}))) as { link?: string };
  if (!data.link) {
    return NextResponse.json({ error: "Failed to start password recovery" }, { status: 502 });
  }

  await auditLog("users:reset-password", session.user?.email ?? "unknown", `Issued recovery link for ${username}`);
  // Return a one-time recovery link for the admin to securely transmit to the user.
  return NextResponse.json({ recoveryLink: data.link });
}
