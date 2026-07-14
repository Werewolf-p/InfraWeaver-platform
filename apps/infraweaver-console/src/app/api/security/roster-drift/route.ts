/**
 * GET /api/security/roster-drift — list the live Authentik directory and flag every
 * ACTIVE account users.yaml does not account for, escalating when an unmanaged
 * account is privileged. See lib/security/roster-drift.ts for the flag rules.
 *
 * Two authenticators (either suffices):
 *   - the in-cluster `roster-drift` CronJob's shared token (`x-internal-cron-token`),
 *     the same pattern as the users-reconcile sweep;
 *   - an admin session (`security:read` / `rbac:admin` / `cluster:admin`) for an
 *     on-demand check from the console.
 *
 * The ALERT is a `result:"failure"` security audit entry emitted when a privileged
 * unmanaged account is found — log-based alerting, the platform's established seam.
 * The response is always 200 with the full report so the CronJob Job stays green
 * unless the endpoint itself is unreachable (drift is reported, not thrown).
 *
 * Fail-closed: no valid token and no authorized session ⇒ 401/403. The middleware
 * (proxy.ts) lets the token-carrying GET past the session gate; this handler
 * re-validates the token (defence in depth).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalCronTokenMatches } from "@/lib/api-helpers";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { detectRosterDrift } from "@/lib/security/roster-drift";
import { auditLog } from "@/lib/audit-log";
import { safeError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronAuthed = internalCronTokenMatches(
    req.headers.get("x-internal-cron-token"),
    process.env.ROSTER_DRIFT_CRON_TOKEN,
  );

  if (!cronAuthed) {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const access = await getSessionRBACContext(session, 60);
    if (!hasAnySessionPermission(access, ["security:read", "rbac:admin", "cluster:admin"])) {
      return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
    }
  }

  try {
    const report = await detectRosterDrift();

    if (report.alert) {
      const detail = report.privilegedUnmanaged
        .map((entry) => `${entry.username} [${entry.privilegedVia ?? "privileged"}] (${entry.reasons.join("+")})`)
        .join(", ");
      await auditLog(
        "security:roster-drift",
        "infraweaver",
        `${report.privilegedUnmanaged.length} unmanaged PRIVILEGED Authentik account(s): ${detail}`,
        { result: "failure", resource: "security" },
      ).catch(() => {});
    } else if (report.drift.length > 0) {
      await auditLog(
        "security:roster-drift",
        "infraweaver",
        `${report.drift.length} unmanaged/suspicious Authentik account(s): ${report.drift.map((e) => e.username).join(", ")}`,
        { result: "success", resource: "security" },
      ).catch(() => {});
    }

    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}
