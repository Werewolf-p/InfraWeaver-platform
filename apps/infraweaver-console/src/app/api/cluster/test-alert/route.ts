import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { requestSafeExternalUrl } from "@/lib/outbound-url";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-test-alert", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (!process.env.DISCORD_WEBHOOK_URL) return NextResponse.json({ error: "DISCORD_WEBHOOK_URL not set" }, { status: 500 });
  const user = session.user?.name ?? session.user?.email ?? "unknown";
  const message = `🧪 InfraWeaver test alert from ${user} at ${new Date().toISOString()}`;
  try {
    const res = await requestSafeExternalUrl(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
      maxResponseBytes: 64_000,
      timeoutMs: 8_000,
    });
    if (!res) throw new Error("Invalid Discord webhook URL");
    if (res.status < 200 || res.status >= 300) throw new Error(`Discord error: ${res.status}`);
    await auditLog("cluster:test-alert", session.user?.email ?? "unknown", "sent Discord test alert");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
