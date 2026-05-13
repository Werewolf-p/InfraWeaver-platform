import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username } = await params;
  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const types = ["totp", "static", "webauthn"] as const;
  for (const t of types) {
    const r = await authentikFetch(`/authenticators/${t}/?user=${user.pk}`);
    if (!r.ok) continue;
    const data = await r.json();
    const results: Array<{ pk: number }> = data.results ?? [];
    for (const item of results) {
      await authentikFetch(`/authenticators/${t}/${item.pk}/`, { method: "DELETE" });
    }
  }

  await auditLog("users:reset-mfa", session.user?.email ?? "unknown", `Reset MFA for ${username}`);
  return NextResponse.json({ ok: true });
}
