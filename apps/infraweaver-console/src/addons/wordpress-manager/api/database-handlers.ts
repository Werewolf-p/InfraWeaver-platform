import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSameOrigin } from "@/lib/api-helpers";
import { AddonHttpError } from "../lib/errors";
import { WpPodExecError } from "../lib/k8s-exec";
import { isValidSiteId } from "../lib/naming";
import {
  getWordpressAccessContext,
  hasWordpressPermission,
  type WordpressPermission,
} from "../lib/wordpress-rbac";
import {
  DB_READ_VERBS,
  DB_WRITE_VERBS,
  dbCleanupParamsSchema,
  dbScheduleParamsSchema,
  type DbReadVerb,
  type DbWriteVerb,
} from "../lib/manage/database";
import { analyzeDatabase, cleanupDatabase, scheduleDatabase } from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the fused Database cockpit. Reads (GET:
 * analyze) require `wordpress:read`; writes (POST: cleanup/schedule) require
 * `wordpress:write`, a same-origin check (CSRF), and leave an audit line. NO
 * unsigned/public endpoint — every verb delegates to a signed `db.*` op that the
 * plugin's verifier enforces (the signed-channel invariant). Same authorize /
 * rate-limit / guard shape as `media-handlers.ts`. The bounded, preview-by-default
 * optimizer these reach is the ONLY database-mutation surface the console has.
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
  if (!checkRateLimit(`wordpress:db-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:db] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Database operation failed — check the server logs for details", 500);
  }
}

/** Per-verb rate ceilings. Preview runs are cheap reads; a real cleanup is heavier. */
const READ_RATE: Record<DbReadVerb, number> = { analyze: 120 };
const WRITE_RATE: Record<DbWriteVerb, number> = { cleanup: 120, schedule: 60 };

function isReadVerb(v: string): v is DbReadVerb {
  return (DB_READ_VERBS as readonly string[]).includes(v);
}

function isWriteVerb(v: string): v is DbWriteVerb {
  return (DB_WRITE_VERBS as readonly string[]).includes(v);
}

/** GET — a read verb (`?read=analyze`). No params: the whole cockpit read-model. */
export async function databaseReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "analyze";
  if (!isReadVerb(verb)) return fail("Unknown database read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => json(await analyzeDatabase(site)));
}

/**
 * POST — a write verb: `{ verb, params }`. RBAC write + same-origin + audit. The
 * cleanup audit line records whether it was a real run (`dry_run: false`) or a
 * preview so the destructive path is always legible in the log.
 */
export async function databaseWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing db op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown database action", 400);

  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`write-${verb}`, gate.username, WRITE_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    switch (verb) {
      case "cleanup": {
        const parsed = dbCleanupParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid db.cleanup parameters", 400);
        const result = await cleanupDatabase(site, parsed.data);
        // A preview leaves no trace on the site; only audit a real (destructive) run.
        if (parsed.data.dry_run === false) {
          await auditLog(
            "wordpress:db-cleanup",
            gate.username,
            `site ${site} cleanup ${parsed.data.categories.join(",") || "(none)"} removed ${result.total}`,
            { result: "success", resource: `wordpress/${site}` },
          );
        }
        return json(result);
      }
      case "schedule": {
        const parsed = dbScheduleParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid db.schedule parameters", 400);
        const result = await scheduleDatabase(site, parsed.data);
        await auditLog(
          "wordpress:db-schedule",
          gate.username,
          `site ${site} schedule ${parsed.data.enabled ? parsed.data.frequency : "off"}`,
          { result: "success", resource: `wordpress/${site}` },
        );
        return json(result);
      }
    }
  });
}
