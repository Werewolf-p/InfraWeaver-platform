import { NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";
import { resolvePrivilegedUserTarget, sessionActor } from "@/lib/user-guards";
import { z } from "zod";

const ResetBody = z.object({
  username: z.string().min(1).max(150).regex(/^[\w.@+-]+$/, "Invalid username"),
});

// C3: password reset is a privileged account-recovery action — require the
// higher users:write / rbac:admin gate, not the low-privilege users:invite.
export const POST = withRoute(["users:write", "rbac:admin"], async (req: NextRequest, session, access) => {
  const parsed = ResetBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { username } = parsed.data;

  const user = await resolvePrivilegedUserTarget(access, username);
  if (user instanceof NextResponse) return user;

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

  await auditLog("users:reset-password", sessionActor(session), `Issued recovery link for ${username}`);
  // Return a one-time recovery link for the admin to securely transmit to the user.
  return NextResponse.json({ recoveryLink: data.link });
});
