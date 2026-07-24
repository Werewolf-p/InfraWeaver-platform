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
  PERF_READ_VERBS,
  PERF_WRITE_VERBS,
  cacheConfigureParamsSchema,
  cachePurgeParamsSchema,
  cacheWarmParamsSchema,
  perfAuditParamsSchema,
  perfSettingsParamsSchema,
  type PerfReadVerb,
  type PerfWriteVerb,
} from "../lib/manage/performance";
import {
  cacheConfigure,
  cachePurge,
  cacheWarm,
  perfAudit,
  perfSettingsSet,
  perfStatus,
} from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the fused Performance surface. Reads (GET:
 * status/audit) require `wordpress:read`; writes (POST: purge/warm/configure/
 * settings) require `wordpress:write`, a same-origin check (CSRF), and leave an
 * audit line. NO unsigned/public endpoint — every verb delegates to a signed
 * `perf.*` / `cache.*` op the plugin's verifier enforces (the signed-channel
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
  if (!checkRateLimit(`wordpress:perf-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:perf] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Performance operation failed — check the server logs for details", 500);
  }
}

/** Per-verb rate ceilings. Warm is the only load-amplifier, so it is the tightest. */
const READ_RATE: Record<PerfReadVerb, number> = { status: 120, audit: 60 };
const WRITE_RATE: Record<PerfWriteVerb, number> = { purge: 120, warm: 20, configure: 60, settings: 60 };

function isReadVerb(v: string): v is PerfReadVerb {
  return (PERF_READ_VERBS as readonly string[]).includes(v);
}

function isWriteVerb(v: string): v is PerfWriteVerb {
  return (PERF_WRITE_VERBS as readonly string[]).includes(v);
}

/** GET — a read verb (`?read=status|audit`). Audit rows ride an optional JSON `p` param. */
export async function performanceReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "status";
  if (!isReadVerb(verb)) return fail("Unknown performance read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    if (verb === "status") return json(await perfStatus(site));
    // audit
    const raw = new URL(req.url).searchParams.get("p");
    let params: unknown = {};
    if (raw) {
      try {
        params = JSON.parse(raw);
      } catch {
        return fail("Malformed perf.audit parameters", 400);
      }
    }
    const parsed = perfAuditParamsSchema.safeParse(params);
    if (!parsed.success) return fail("Invalid perf.audit parameters", 400);
    return json(await perfAudit(site, parsed.data));
  });
}

/** POST — a write verb: `{ verb, params }`. RBAC write + same-origin + audit. */
export async function performanceWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing perf/cache op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown performance action", 400);

  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`write-${verb}`, gate.username, WRITE_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    switch (verb) {
      case "purge": {
        const parsed = cachePurgeParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid cache.purge parameters", 400);
        const result = await cachePurge(site, parsed.data);
        await auditLog("wordpress:cache-purge", gate.username, `site ${site} purge ${parsed.data.scope}`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "warm": {
        const parsed = cacheWarmParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid cache.warm parameters", 400);
        const result = await cacheWarm(site, parsed.data);
        await auditLog("wordpress:cache-warm", gate.username, `site ${site} warm`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "configure": {
        const parsed = cacheConfigureParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid cache.configure parameters", 400);
        const result = await cacheConfigure(site, parsed.data);
        await auditLog("wordpress:cache-configure", gate.username, `site ${site} configure cache`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "settings": {
        const parsed = perfSettingsParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid perf.settings.set parameters", 400);
        const result = await perfSettingsSet(site, parsed.data);
        await auditLog("wordpress:perf-settings", gate.username, `site ${site} perf settings`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
    }
  });
}
