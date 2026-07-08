import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
import { runHealthSweep } from "../lib/health-sweep";
import {
  getWordpressAccessContext,
  hasWordpressPermission,
  type WordpressPermission,
} from "../lib/wordpress-rbac";
import {
  confirmFingerprint,
  createExternalSite,
  deleteExternalSite,
  issueBundle,
  listExternalSiteViews,
  verifyExternalSite,
} from "../lib/iwsl-enrollment";
import { buildConnectorPackage } from "../lib/connector-package";
import { enrollManagedSite, getManagedLink, unlinkManagedSite } from "../lib/iwsl-managed";
import {
  connectorDebug,
  connectorHealthCheck,
  deactivateConnector,
  rotateConnectorKey,
  setConnectorQuarantine,
  updateConnectorPlugin,
} from "../lib/iwsl-managed-ops";
import { isValidSiteId } from "../lib/naming";

/**
 * API handlers for IWSL external sites (§5 enrollment + §12.5 link state).
 * Same authorize/rate-limit/guard shape as handlers.ts; kept separate because
 * these operate on link records in the console namespace, not provisioned
 * cluster sites.
 */

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type AccessContext = Awaited<ReturnType<typeof getWordpressAccessContext>>;
type AuthzResult =
  | { ok: false; error: NextResponse; ctx: AccessContext | null }
  | { ok: true; ctx: AccessContext };

/**
 * External-site links are namespace-level objects (they gate a signing path to
 * a remote site), so only the namespace-wide grant applies — per-site scopes
 * name provisioned cluster sites and don't map onto link records. Managed
 * links (§5.1) DO name a provisioned site, so those handlers pass `site` and
 * the check honours the per-site scope too (mirrors handlers.ts).
 */
async function authorize(permission: WordpressPermission, site?: string): Promise<AuthzResult> {
  const session = await auth();
  if (!session) return { ok: false, error: fail("Unauthorized", 401), ctx: null };
  const ctx = await getWordpressAccessContext(session);
  const namespaceWide = hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, "");
  const scoped = site ? hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, site) : false;
  if (!namespaceWide && !scoped) return { ok: false, error: fail("Forbidden", 403), ctx };
  return { ok: true, ctx };
}

const RATE_WINDOW_MS = 60_000;

function rateLimited(action: string, user: string, max: number): NextResponse | null {
  if (!checkRateLimit(`wordpress:iwsl-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:iwsl] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    return fail("Operation failed — check the server logs for details", 500);
  }
}

const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80),
  url: z.string().url("a valid https URL is required").max(2000),
}).strict();

const verifySchema = z.object({
  // Air-gapped/NAT fallback (§5): the operator pastes the proof document
  // instead of IW pulling it. Omitted → IW fetches the enroll-proof endpoint.
  proof: z.string().max(64 * 1024).optional(),
}).strict();

export async function listExternalSitesHandler(): Promise<NextResponse> {
  const gate = await authorize("wordpress:read");
  if (!gate.ok) return gate.error;
  return guard(async () => json({ sites: await listExternalSiteViews() }));
}

export async function createExternalSiteHandler(req: NextRequest): Promise<NextResponse> {
  const gate = await authorize("wordpress:write");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("create", gate.ctx.username, 10);
  if (limited) return limited;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  return guard(async () => json({ site: await createExternalSite(parsed.data, gate.ctx.username) }, 201));
}

/**
 * POST — mint and return the `.iwenroll` bundle. Every call issues a fresh
 * single-use enroll_secret (invalidating the previous one), so the response is
 * sensitive for its 15-minute TTL, must never be cached, and must not be
 * reachable via GET (CSRF through top-level navigation under SameSite=Lax).
 */
export async function downloadBundleHandler(siteId: string): Promise<NextResponse | Response> {
  if (!SITE_ID_RE.test(siteId)) return fail("Invalid site id", 400);
  const gate = await authorize("wordpress:write");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("bundle", gate.ctx.username, 10);
  if (limited) return limited;
  try {
    const bundle = await issueBundle(siteId);
    return new Response(bundle.content, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[wordpress:iwsl] bundle error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    return fail("Operation failed — check the server logs for details", 500);
  }
}

export async function verifyExternalSiteHandler(req: NextRequest, siteId: string): Promise<NextResponse> {
  if (!SITE_ID_RE.test(siteId)) return fail("Invalid site id", 400);
  const gate = await authorize("wordpress:write");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("verify", gate.ctx.username, 20);
  if (limited) return limited;
  const body = await req.json().catch(() => ({}));
  const parsed = verifySchema.safeParse(body ?? {});
  if (!parsed.success) return fail("Invalid verify request", 400);
  return guard(async () => {
    const outcome = await verifyExternalSite(siteId, parsed.data.proof);
    // Verification failures are expected operational states (§12.5 reasons),
    // not HTTP errors — the card renders the reason.
    return json(outcome, outcome.ok ? 200 : 422);
  });
}

export async function confirmFingerprintHandler(siteId: string): Promise<NextResponse> {
  if (!SITE_ID_RE.test(siteId)) return fail("Invalid site id", 400);
  const gate = await authorize("wordpress:write");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("confirm", gate.ctx.username, 20);
  if (limited) return limited;
  return guard(async () => json({ site: await confirmFingerprint(siteId) }));
}

export async function deleteExternalSiteHandler(siteId: string): Promise<NextResponse> {
  if (!SITE_ID_RE.test(siteId)) return fail("Invalid site id", 400);
  const gate = await authorize("wordpress:admin");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("delete", gate.ctx.username, 10);
  if (limited) return limited;
  return guard(async () => {
    await deleteExternalSite(siteId);
    return json({ ok: true });
  });
}

/**
 * GET — the Connector plugin as a standard WordPress plugin zip, for manual
 * install on external sites. Read access suffices: the plugin contains no
 * secrets or per-site material — enrollment security lives in the bundle.
 */
export async function downloadConnectorPluginHandler(): Promise<NextResponse | Response> {
  const gate = await authorize("wordpress:read");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("plugin-download", gate.ctx.username, 20);
  if (limited) return limited;
  try {
    const pkg = await buildConnectorPackage();
    return new Response(new Uint8Array(pkg.zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${pkg.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[wordpress:iwsl] plugin download error:", err instanceof Error ? err.message : err);
    return fail("Plugin package unavailable — check the server logs for details", 500);
  }
}

// ── Managed links (§5.1 — IW-provisioned cluster sites) ─────────────────────

/** GET — the site's managed link state (null when never enrolled). */
export async function getManagedLinkHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("managed-read", gate.ctx.username, 60);
  if (limited) return limited;
  return guard(async () => json({ link: await getManagedLink(site) }));
}

/**
 * POST — install the Connector into the site's pod and run the full §5.1
 * enrollment (bundle → enroll → proof → verify → auto-confirm). Admin on the
 * site: this creates a signing target for remote management commands.
 */
export async function enrollManagedSiteHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:admin", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("managed-enroll", gate.ctx.username, 5);
  if (limited) return limited;
  return guard(async () => json({ link: await enrollManagedSite(site, gate.ctx.username) }, 201));
}

const OPS_ACTIONS = ["health", "debug", "rotate", "quarantine", "release", "deactivate", "update-plugin"] as const;
type OpsAction = (typeof OPS_ACTIONS)[number];

const opsSchema = z.object({ action: z.enum(OPS_ACTIONS) }).strict();

/** Diagnostics mutate only link bookkeeping; the rest change the trust state. */
const OPS_POLICY: Record<OpsAction, { permission: WordpressPermission; ratePerMin: number }> = {
  health: { permission: "wordpress:write", ratePerMin: 30 },
  debug: { permission: "wordpress:write", ratePerMin: 30 },
  rotate: { permission: "wordpress:admin", ratePerMin: 5 },
  quarantine: { permission: "wordpress:admin", ratePerMin: 10 },
  release: { permission: "wordpress:admin", ratePerMin: 10 },
  deactivate: { permission: "wordpress:admin", ratePerMin: 5 },
  "update-plugin": { permission: "wordpress:admin", ratePerMin: 5 },
};

/**
 * POST — connector operations on a §5.1 managed link: signed health check,
 * deep diagnostics, WP-key rotation (§8), quarantine/release, the §8 kill
 * switch, and in-place plugin update.
 */
export async function managedOpsHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const parsed = opsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Invalid connector operation", 400);
  const action = parsed.data.action;
  const policy = OPS_POLICY[action];
  const gate = await authorize(policy.permission, site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`ops-${action}`, gate.ctx.username, policy.ratePerMin);
  if (limited) return limited;
  return guard(async () => {
    switch (action) {
      case "health":
        return json({ health: await connectorHealthCheck(site) });
      case "debug":
        return json({ debug: await connectorDebug(site) });
      case "rotate":
        return json({ rotation: await rotateConnectorKey(site) });
      case "quarantine":
        await setConnectorQuarantine(site, true);
        return json({ ok: true });
      case "release":
        await setConnectorQuarantine(site, false);
        return json({ ok: true });
      case "deactivate":
        return json(await deactivateConnector(site));
      case "update-plugin":
        return json(await updateConnectorPlugin(site));
    }
  });
}

/** DELETE — remove the link and best-effort uninstall the plugin. */
export async function unlinkManagedSiteHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:admin", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("managed-unlink", gate.ctx.username, 10);
  if (limited) return limited;
  return guard(async () => {
    await unlinkManagedSite(site);
    return json({ ok: true });
  });
}

// ── Server-driven health sweep (§12.5 — hourly CronJob) ──────────────────────

/**
 * Constant-time compare of the internal cron token. Returns false whenever the
 * shared secret is unset/empty (fail-closed — an unconfigured deployment can't
 * be driven by the header path) or the header is missing/mismatched.
 */
function cronTokenValid(req: NextRequest): boolean {
  const expected = process.env.WORDPRESS_HEALTH_CRON_TOKEN;
  if (!expected) return false;
  const provided = req.headers.get("x-internal-cron-token");
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  // timingSafeEqual throws on length mismatch — length itself is not secret.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * POST — run the connector health sweep across every commandable managed link.
 * Authenticated either by the in-cluster cron token (`x-internal-cron-token`,
 * how the hourly CronJob calls in) or by an operator session with
 * `wordpress:write`. Fail-closed: no valid token and no authorized session ⇒
 * rejected.
 */
export async function healthSweepHandler(req: NextRequest): Promise<NextResponse> {
  if (!cronTokenValid(req)) {
    const gate = await authorize("wordpress:write");
    if (!gate.ok) return gate.error;
    const limited = rateLimited("health-sweep", gate.ctx.username, 6);
    if (limited) return limited;
  }
  return guard(async () => json({ summary: await runHealthSweep() }));
}
