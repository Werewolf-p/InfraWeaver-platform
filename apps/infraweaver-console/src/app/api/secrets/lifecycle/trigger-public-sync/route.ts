import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { triggerPublicSync } from "@/lib/secrets/public-mirror";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";

/**
 * POST /api/secrets/lifecycle/trigger-public-sync — dispatch the `sync-to-public`
 * GitHub Actions workflow. Low-med risk: only dispatches a named workflow, no
 * secret data touched. cluster:admin + rate-limited + audited.
 */
export const POST = withRoute("cluster:admin", async (req, session) => {
  if (!checkRateLimit(rateLimitKey("secret-public-sync", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const actor = session.user?.email ?? "unknown";
  try {
    await triggerPublicSync();
    await auditLog("secret:trigger-public-sync", actor, "dispatched sync-to-public workflow", {
      resource: "sync-to-public",
      req,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    await auditLog("secret:trigger-public-sync", actor, `dispatch failed: ${safeError(err)}`, {
      result: "failure",
      resource: "sync-to-public",
      req,
    });
    return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
  }
});
