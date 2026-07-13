/**
 * POST /api/users/reconcile — converge all users to their users.yaml + RBAC state.
 *
 * Two authenticators (either suffices):
 *   - the in-cluster `users-reconcile` CronJob's shared token
 *     (`x-internal-cron-token`), the same pattern as the WordPress health sweep;
 *   - an admin session (`users:write` / `rbac:admin`) for a manual "reconcile now".
 *
 * Fail-closed: no valid token and no authorized session ⇒ 401/403. The middleware
 * (proxy.ts) lets the token-carrying request past the session gate; this handler
 * re-validates the token (defence in depth).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalCronTokenMatches } from "@/lib/api-helpers";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { reconcileUsers } from "@/lib/users/reconcile";
import { safeError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cronAuthed = internalCronTokenMatches(
    req.headers.get("x-internal-cron-token"),
    process.env.USERS_RECONCILE_CRON_TOKEN,
  );

  if (!cronAuthed) {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const access = await getSessionRBACContext(session, 60);
    if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
      return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
    }
  }

  try {
    const summary = await reconcileUsers();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}
