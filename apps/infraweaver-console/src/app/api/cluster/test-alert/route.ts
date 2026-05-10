import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return NextResponse.json({ error: "DISCORD_WEBHOOK_URL not set" }, { status: 500 });
  const user = session.user?.name ?? session.user?.email ?? "unknown";
  const message = `🧪 InfraWeaver test alert from ${user} at ${new Date().toISOString()}`;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) throw new Error(`Discord error: ${res.status}`);
    await auditLog("cluster:test-alert", session.user?.email ?? "unknown", "sent Discord test alert");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
