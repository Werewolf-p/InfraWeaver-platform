import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { requestSafeExternalUrl } from "@/lib/outbound-url";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "cluster-test-alert", limit: 5, windowMs: 60_000 } },
  async ({ session }) => {
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
    } catch (err) {
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
