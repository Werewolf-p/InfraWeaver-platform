import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
import { WpPodExecError } from "../lib/k8s-exec";
import { isValidSiteId } from "../lib/naming";
import {
  getWordpressAccessContext,
  hasWordpressPermission,
  type WordpressPermission,
} from "../lib/wordpress-rbac";
import {
  activityLogParamsSchema,
  isInsightsReadVerb,
  statsSummaryParamsSchema,
  statsTimeseriesParamsSchema,
  type InsightsReadVerb,
} from "../lib/manage/insights";
import { activityLog, statsSummary, statsTimeseries } from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the Insights surface. All three verbs are
 * READ-ONLY (GET: summary/timeseries/activity) and require `wordpress:read`;
 * there is no unsigned/public endpoint and no write verb (nothing here mutates,
 * so no same-origin/CSRF guard is needed — every read delegates to a signed
 * `stats.*` / `activity.log` op the plugin's verifier enforces, the signed-channel
 * invariant). Same authorize / rate-limit / guard shape as `media-handlers.ts`.
 */

const RATE_WINDOW_MS = 60_000;

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function authorize(
  permission: WordpressPermission,
  site: string,
): Promise<{ ok: true; username: string } | { ok: false; error: NextResponse }> {
  const session = await auth();
  if (!session) return { ok: false, error: fail("Unauthorized", 401) };
  const ctx = await getWordpressAccessContext(session);
  const namespaceWide = hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, "");
  const scoped = hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, site);
  if (!namespaceWide && !scoped) return { ok: false, error: fail("Forbidden", 403) };
  return { ok: true, username: ctx.username };
}

function rateLimited(action: string, user: string, max: number): NextResponse | null {
  if (!checkRateLimit(`wordpress:insights-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:insights] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Insights read failed — check the server logs for details", 500);
  }
}

/** Per-verb rate ceilings — reads are polled by the panels, so they are generous. */
const READ_RATE: Record<InsightsReadVerb, number> = { summary: 120, timeseries: 120, activity: 120 };

/** Parse the JSON `p` query param (verb params) into an object; `{}` when absent. */
function readParams(req: NextRequest): { ok: true; value: unknown } | { ok: false } {
  const raw = new URL(req.url).searchParams.get("p");
  if (!raw) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** GET — a read verb (`?read=summary|timeseries|activity`); params ride a JSON `p` query. */
export async function insightsReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "summary";
  if (!isInsightsReadVerb(verb)) return fail("Unknown insights read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    const raw = readParams(req);
    if (!raw.ok) return fail("Malformed insights parameters", 400);

    if (verb === "summary") {
      const parsed = statsSummaryParamsSchema.safeParse(raw.value);
      if (!parsed.success) return fail("Invalid stats.summary parameters", 400);
      return json(await statsSummary(site, parsed.data));
    }
    if (verb === "timeseries") {
      const parsed = statsTimeseriesParamsSchema.safeParse(raw.value);
      if (!parsed.success) return fail("Invalid stats.timeseries parameters", 400);
      return json(await statsTimeseries(site, parsed.data));
    }
    // verb === "activity"
    const parsed = activityLogParamsSchema.safeParse(raw.value);
    if (!parsed.success) return fail("Invalid activity.log parameters", 400);
    return json(await activityLog(site, parsed.data));
  });
}
