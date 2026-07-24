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
  SITE_HEALTH_READ_VERBS,
  SITE_HEALTH_WRITE_VERBS,
  clampScanBudgetMs,
  linkScanParamsSchema,
  redirectCreateParamsSchema,
  redirectDeleteParamsSchema,
  redirectImportParamsSchema,
  redirectTogglesParamsSchema,
  type SiteHealthReadVerb,
  type SiteHealthWriteVerb,
} from "../lib/manage/site-health";
import {
  createRedirect,
  deleteRedirect,
  importRedirects,
  listRedirects,
  runLinkScan,
  setRedirectToggles,
  siteHealthSnapshot,
} from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the Site Health surface. Reads (GET:
 * snapshot/redirects) require `wordpress:read`; writes (POST: scan + redirect
 * mutations) require `wordpress:write`, a same-origin check (CSRF), and leave an
 * audit line. NO unsigned/public endpoint — every verb delegates to a signed
 * method the plugin's verifier enforces (the signed-channel invariant). The
 * redirect gauntlet, SSRF guard and entitlement gates all live in the connector;
 * the console never re-implements them. Same shape as `media-handlers.ts`.
 *
 * Maintenance mode is deliberately NOT here — it goes through the orchestrator on
 * the existing `/maintenance` PUT so the mu-plugin fallback and the signed engine
 * stay mutually exclusive on one endpoint.
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
  if (!checkRateLimit(`wordpress:sitehealth-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:sitehealth] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Site Health operation failed — check the server logs for details", 500);
  }
}

/** Per-verb rate ceilings. The scan can run ~15 s so it's tighter than table reads. */
const READ_RATE: Record<SiteHealthReadVerb, number> = { snapshot: 120, redirects: 120 };
const WRITE_RATE: Record<SiteHealthWriteVerb, number> = {
  scan: 12,
  "redirect-create": 120,
  "redirect-delete": 120,
  "redirect-import": 20,
  "redirect-toggles": 60,
};

function isReadVerb(v: string): v is SiteHealthReadVerb {
  return (SITE_HEALTH_READ_VERBS as readonly string[]).includes(v);
}

function isWriteVerb(v: string): v is SiteHealthWriteVerb {
  return (SITE_HEALTH_WRITE_VERBS as readonly string[]).includes(v);
}

/** GET — a read verb (`?read=snapshot|redirects`). */
export async function siteHealthReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "snapshot";
  if (!isReadVerb(verb)) return fail("Unknown site-health read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    if (verb === "redirects") return json(await listRedirects(site));
    return json(await siteHealthSnapshot(site));
  });
}

/** POST — a write verb: `{ verb, params }`. RBAC write + same-origin + audit. */
export async function siteHealthWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown site-health action", 400);

  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`write-${verb}`, gate.username, WRITE_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    switch (verb) {
      case "scan": {
        const parsed = linkScanParamsSchema.safeParse(body?.params ?? {});
        if (!parsed.success) return fail("Invalid links.scan parameters", 400);
        // Console-side clamp for the exec transport (the engine clamps again).
        const budget = clampScanBudgetMs(parsed.data.budget_ms);
        const result = await runLinkScan(site, { budget_ms: budget });
        await auditLog("wordpress:links-scan", gate.username, `site ${site} broken-link scan (budget ${budget}ms)`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "redirect-create": {
        const parsed = redirectCreateParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid redirects.create parameters", 400);
        const result = await createRedirect(site, parsed.data);
        await auditLog("wordpress:redirect-create", gate.username, `site ${site} redirect ${parsed.data.source} → ${parsed.data.target}`, {
          result: result.ok ? "success" : "failure",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "redirect-delete": {
        const parsed = redirectDeleteParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid redirects.delete parameters", 400);
        const result = await deleteRedirect(site, parsed.data);
        await auditLog("wordpress:redirect-delete", gate.username, `site ${site} redirect ${parsed.data.id} deleted`, {
          result: result.ok ? "success" : "failure",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "redirect-import": {
        const parsed = redirectImportParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid redirects.import parameters", 400);
        const result = await importRedirects(site, parsed.data);
        await auditLog("wordpress:redirect-import", gate.username, `site ${site} imported ${parsed.data.rules.length} redirect rule(s)`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "redirect-toggles": {
        const parsed = redirectTogglesParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid redirects.set_toggles parameters", 400);
        const result = await setRedirectToggles(site, parsed.data);
        await auditLog("wordpress:redirect-toggles", gate.username, `site ${site} redirect toggles updated`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
    }
  });
}
