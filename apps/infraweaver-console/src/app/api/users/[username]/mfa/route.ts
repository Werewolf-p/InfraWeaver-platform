import { NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";
import { resolvePrivilegedUserTarget, sessionActor } from "@/lib/user-guards";

// C3: stripping a second factor is a privileged account-recovery action —
// require the higher users:write / rbac:admin gate, not the low-privilege
// users:invite enrollment role.
export const DELETE = withRoute(["users:write", "rbac:admin"], async (_req: NextRequest, session, access, ctx) => {
  const { username } = (await ctx.params) as { username: string };
  const user = await resolvePrivilegedUserTarget(access, username);
  if (user instanceof NextResponse) return user;

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

  await auditLog("users:reset-mfa", sessionActor(session), `Reset MFA for ${username}`);
  return NextResponse.json({ ok: true });
});
