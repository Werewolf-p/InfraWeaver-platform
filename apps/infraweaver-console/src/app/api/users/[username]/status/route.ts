import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";

const statusBodySchema = z.object({
  active: z.boolean(),
}).strict();

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

  const result = statusBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  const { username } = await params;
  const { active } = result.data;

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

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
    session.user?.email ?? "unknown",
    `Set is_active=${active} for ${username}`
  );
  return NextResponse.json({ ok: true });
}
