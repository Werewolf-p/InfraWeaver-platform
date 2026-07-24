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
  CONTENT_BRANDING_READ_VERBS,
  CONTENT_BRANDING_WRITE_VERBS,
  brandingSetParamsSchema,
  configSetParamsSchema,
  contentDuplicateParamsSchema,
  type ContentBrandingReadVerb,
  type ContentBrandingWriteVerb,
} from "../lib/manage/content-branding";
import {
  duplicateContent,
  getBranding,
  getConfig,
  setBranding,
  setConfig,
} from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the Content / Branding / Config surfaces (mirror
 * of `media-handlers.ts`). Reads (GET: branding/config) require `wordpress:read`;
 * writes (POST) require a same-origin check (CSRF) + audit, with per-verb RBAC:
 * `branding-set` = `wordpress:admin` (a fleet brand push, like `entitlements.set`),
 * `config-set` / `content-duplicate` = `wordpress:write`. NO unsigned/public endpoint
 * — every verb delegates to a signed method the plugin's verifier enforces (the
 * signed-channel invariant). Secrets are never rendered (none cross this surface).
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
  if (!checkRateLimit(`wordpress:content-branding-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:content-branding] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail(
        "The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.",
        502,
      );
    }
    return fail("Operation failed — check the server logs for details", 500);
  }
}

const READ_RATE: Record<ContentBrandingReadVerb, number> = { branding: 60, config: 60 };
/** Per-verb RBAC + rate ceilings for the write verbs. */
const WRITE_POLICY: Record<
  ContentBrandingWriteVerb,
  { readonly permission: WordpressPermission; readonly max: number }
> = {
  "branding-set": { permission: "wordpress:admin", max: 20 },
  "config-set": { permission: "wordpress:write", max: 20 },
  "content-duplicate": { permission: "wordpress:write", max: 30 },
};

function isReadVerb(v: string): v is ContentBrandingReadVerb {
  return (CONTENT_BRANDING_READ_VERBS as readonly string[]).includes(v);
}

function isWriteVerb(v: string): v is ContentBrandingWriteVerb {
  return (CONTENT_BRANDING_WRITE_VERBS as readonly string[]).includes(v);
}

/** GET — a read verb (`?read=branding|config`). Read-only, safe when locked. */
export async function contentBrandingReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "branding";
  if (!isReadVerb(verb)) return fail("Unknown read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    if (verb === "config") return json(await getConfig(site));
    return json(await getBranding(site));
  });
}

/** POST — a write verb: `{ verb, params }`. Per-verb RBAC + same-origin + audit. */
export async function contentBrandingWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown action", 400);

  const policy = WRITE_POLICY[verb];
  const gate = await authorize(policy.permission, site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`write-${verb}`, gate.username, policy.max);
  if (limited) return limited;

  return guard(async () => {
    switch (verb) {
      case "branding-set": {
        const parsed = brandingSetParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid branding parameters", 400);
        const result = await setBranding(site, parsed.data.settings);
        await auditLog("wordpress:branding-set", gate.username, `site ${site} brand kit updated`, {
          result: result.ok ? "success" : "failure",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "config-set": {
        const parsed = configSetParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid config parameters", 400);
        const result = await setConfig(site, parsed.data.values);
        await auditLog(
          "wordpress:config-set",
          gate.username,
          `site ${site} config apply ${Object.keys(parsed.data.values).join(",") || "none"}`,
          { result: "success", resource: `wordpress/${site}` },
        );
        return json(result);
      }
      case "content-duplicate": {
        const parsed = contentDuplicateParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid duplicate parameters", 400);
        const result = await duplicateContent(site, parsed.data.post_id);
        await auditLog("wordpress:content-duplicate", gate.username, `site ${site} duplicate post ${parsed.data.post_id}`, {
          result: result.ok ? "success" : "failure",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
    }
  });
}
