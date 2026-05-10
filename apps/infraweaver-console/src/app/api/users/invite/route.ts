import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { email, groups, expiryHours } = await req.json() as {
    email: string;
    groups: string[];
    expiryHours: number;
  };
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const expires = new Date(Date.now() + (expiryHours || 24) * 3600 * 1000).toISOString();
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
  return NextResponse.json({
    url: `https://auth.rlservers.com/if/flow/default-invitation-flow/?itoken=${token}`,
  });
}
