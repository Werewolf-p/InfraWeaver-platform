import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
import { WpPodExecError } from "../lib/k8s-exec";
import { getWordpressAccessContext, hasWordpressPermission } from "../lib/wordpress-rbac";

/**
 * Shared read guard for the fleet dashboard's GET endpoints. A fleet view spans
 * every managed site, so it authenticates the namespace-wide `wordpress:read`
 * grant (not a per-site scope) — the same posture as the metrics exporter's fleet
 * read. Rate-limited per user, and wraps the aggregator in the addon's standard
 * error funnel so an exec/DB blip degrades to a clean HTTP error, never a stack
 * trace. One place so every fleet route stays consistent (and parallel work can't
 * drift the auth posture).
 */
export async function withFleetRead(
  action: string,
  ratePerMin: number,
  aggregate: () => Promise<unknown>,
): Promise<NextResponse> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await getWordpressAccessContext(session);
  if (!hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, "wordpress:read", "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(`wordpress:fleet-${action}:${ctx.username || "anon"}`, ratePerMin, 60_000)) {
    return NextResponse.json({ error: "Too many requests — slow down and try again shortly" }, { status: 429 });
  }
  try {
    return NextResponse.json(await aggregate());
  } catch (err) {
    console.error(`[wordpress:fleet] ${action} error:`, err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof WpPodExecError) {
      return NextResponse.json(
        { error: "A site's WordPress didn't respond as expected — retry in a moment." },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "Fleet read failed — check the server logs for details" }, { status: 500 });
  }
}
