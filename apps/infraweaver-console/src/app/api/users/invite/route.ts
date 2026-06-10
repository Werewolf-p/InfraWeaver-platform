import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";
import { publicHost } from "@/lib/domain";

const InviteBody = z.object({
  email: z.string().email().max(254),
  groups: z.array(z.string().max(64)).max(20).optional().default([]),
  expiryHours: z.number().int().min(1).max(168).optional().default(24),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = InviteBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { email, groups, expiryHours } = parsed.data;

  const expires = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();
  const r = await authentikFetch("/stages/invitation/invitations/", {
    method: "POST",
    body: JSON.stringify({ expires, fixed_data: { email }, flow: groups }),
  });

  if (!r.ok) {
    const text = await r.text();
    return NextResponse.json({ error: `Authentik error: ${text}` }, { status: 502 });
  }

  const inv = await r.json();
  const token = inv.pk ?? inv.token ?? "";
  await auditLog("users:invite", session.user?.email ?? "unknown", `Invited ${email}`);
  const authentikBaseUrl = process.env.AUTHENTIK_PUBLIC_URL ?? `https://${publicHost("auth")}`;
  return NextResponse.json({
    url: `${authentikBaseUrl}/if/flow/default-invitation-flow/?itoken=${token}`,
  });
}
