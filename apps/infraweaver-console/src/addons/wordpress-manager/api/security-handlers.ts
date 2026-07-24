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
  SECURITY_READ_VERBS,
  SECURITY_WRITE_VERBS,
  consentSetParamsSchema,
  securityHardenParamsSchema,
  type SecurityReadVerb,
  type SecurityWriteVerb,
} from "../lib/manage/security-consent";
import {
  consentGetConfig,
  consentSetConfig,
  protectionStatus,
  securityHarden,
  securityScan,
} from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the fused Site Security surface. Reads (GET:
 * scan/status/consent) require `wordpress:read`; writes (POST: harden/consent)
 * require `wordpress:write`, a same-origin check (CSRF), and leave an audit line.
 * NO unsigned/public endpoint — every verb delegates to a signed method the
 * plugin's verifier enforces (the signed-channel invariant). Same authorize /
 * rate-limit / guard shape as the media + iwsl handlers.
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
  if (!checkRateLimit(`wordpress:security-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:security] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Security operation failed — check the server logs for details", 500);
  }
}

/** Per-verb rate ceilings. Reads are frequent; config writes are deliberate + rare. */
const READ_RATE: Record<SecurityReadVerb, number> = { scan: 30, status: 120, consent: 120 };
const WRITE_RATE: Record<SecurityWriteVerb, number> = { harden: 30, consent: 30 };

function isReadVerb(v: string): v is SecurityReadVerb {
  return (SECURITY_READ_VERBS as readonly string[]).includes(v);
}

function isWriteVerb(v: string): v is SecurityWriteVerb {
  return (SECURITY_WRITE_VERBS as readonly string[]).includes(v);
}

/** GET — a read verb (`?read=scan|status|consent`). All read verbs take no params. */
export async function securityReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "scan";
  if (!isReadVerb(verb)) return fail("Unknown security read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    if (verb === "status") return json(await protectionStatus(site));
    if (verb === "consent") return json(await consentGetConfig(site));
    return json(await securityScan(site));
  });
}

/** POST — a write verb: `{ verb, params }`. RBAC write + same-origin + audit. */
export async function securityWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing security op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown security action", 400);

  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`write-${verb}`, gate.username, WRITE_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    if (verb === "harden") {
      const parsed = securityHardenParamsSchema.safeParse(body?.params);
      if (!parsed.success) return fail("Invalid security.harden parameters", 400);
      const result = await securityHarden(site, parsed.data);
      const summary = parsed.data.revert ? "revert" : `csp=${parsed.data.config?.csp ?? "unchanged"}`;
      await auditLog("wordpress:security-harden", gate.username, `site ${site} harden ${summary}`, {
        result: "success",
        resource: `wordpress/${site}`,
      });
      return json(result);
    }
    // verb === "consent" → setConfig
    const parsed = consentSetParamsSchema.safeParse(body?.params);
    if (!parsed.success) return fail("Invalid consent.setConfig parameters", 400);
    const result = await consentSetConfig(site, parsed.data);
    const enabled = parsed.data.settings.enabled === true;
    await auditLog("wordpress:consent-set", gate.username, `site ${site} consent ${enabled ? "enabled" : "updated"}`, {
      result: "success",
      resource: `wordpress/${site}`,
    });
    return json(result);
  });
}
