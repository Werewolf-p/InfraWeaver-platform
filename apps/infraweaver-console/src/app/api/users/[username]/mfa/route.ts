import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";

const resetMfaBodySchema = z.object({}).strict();

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await req.text();
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
  }
  const result = resetMfaBodySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
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
