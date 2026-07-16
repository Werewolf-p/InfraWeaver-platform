import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { renewSelfToken } from "@/lib/secrets/openbao-token";
import { withRoute } from "@/lib/route-utils";

/**
 * POST /api/secrets/lifecycle/renew-token — low-risk remediation: extend the
 * CURRENT OpenBao token's lease (renew-self). Non-destructive; never returns the
 * token value. cluster:admin + rate-limited + audited.
 */
export const POST = withRoute("cluster:admin", async (req, session) => {
  if (!checkRateLimit(rateLimitKey("secret-renew-token", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const actor = session.user?.email ?? "unknown";
  const result = await renewSelfToken();
  if (!result.ok) {
    await auditLog("secret:renew-token", actor, `renew OpenBao token failed: ${result.error ?? "unknown"}`, {
      result: "failure",
      resource: "openbao-token",
      req,
    });
    return NextResponse.json({ ok: false, error: result.error ?? "Renew failed" }, { status: 502 });
  }

  await auditLog("secret:renew-token", actor, `renewed OpenBao token (new TTL ${result.ttlSeconds ?? "unknown"}s)`, {
    resource: "openbao-token",
    req,
  });
  return NextResponse.json({ ok: true, ttlSeconds: result.ttlSeconds });
});
