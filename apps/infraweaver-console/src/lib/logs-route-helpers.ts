/**
 * @/lib/logs-route-helpers — Response-producing guards for the logs/metrics
 * API routes. Split from @/lib/logs-access (which is also loaded by non-route
 * code, e.g. the gamehub addon libs) so that module never imports next/server
 * at runtime.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { canAccessLogsTarget, getGameHubAccessContext, type GameHubAccessContext } from "@/lib/logs-access";

/**
 * Per-target BOLA gate used by every logs/metrics route: build the caller's
 * scoped access context and verify they may read the given namespace/pod.
 * Returns the canonical 403 when denied, else the resolved context.
 *
 *   const access = await requireLogsTargetAccess(session, namespace, pod);
 *   if (access instanceof NextResponse) return access;
 */
export async function requireLogsTargetAccess(
  session: Session | null,
  namespace: string,
  pod: string,
): Promise<NextResponse | GameHubAccessContext> {
  const access = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(access.groups, access.username, access.roleAssignments, namespace, pod)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return access;
}

/** Canonical plain-text 503 the log-tail routes return when the API server is unreachable. */
export function kubeUnavailableLogsResponse(): NextResponse {
  return new NextResponse("Kubernetes unavailable — cannot retrieve logs", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
