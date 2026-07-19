import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
import { WpPodExecError } from "../lib/k8s-exec";
import { runHealthSweep } from "../lib/health-sweep";
import { runRotationSweep } from "../lib/rotation-sweep";
import { runConnectorUpdateSweep } from "../lib/update-sweep";
import { exportConnectorMetrics } from "../lib/manage/metrics";
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
  confirmSiteIdentity,
  connectorDebug,
  connectorHealthCheck,
  deactivateConnector,
  externalConnectorHealthCheck,
  rotateConnectorKey,
  setConnectorQuarantine,
  setRotationPolicy,
  updateConnectorPlugin,
} from "../lib/iwsl-managed-ops";
import { MAX_SITE_INTERVAL_MS } from "../lib/rotation-policy";
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

/**
 * The Connector version bundled in this console image, for the client-side
 * "update available" compare. Best-effort: a missing vendor dir must degrade to
 * "no signal" (badge simply never shows), never fail the list/link read.
 */
async function safeBundledConnectorVersion(): Promise<string | null> {
  try {
    return (await buildConnectorPackage()).version;
  } catch {
    return null;
  }
}

async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:iwsl] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond as expected — its database or pod may be briefly unavailable. Retry in a moment.", 502);
    }
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
  return guard(async () => {
    const [sites, bundledConnectorVersion] = await Promise.all([
      listExternalSiteViews(),
      safeBundledConnectorVersion(),
    ]);
    return json({ sites, bundledConnectorVersion });
  });
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
  return guard(async () => {
    const site = await confirmFingerprint(siteId);
    // §5 — bind the canonical identity now instead of on the first sweep: one
    // signed health.check folds the self-reported URL into the link. Best-effort;
    // the link is already active, so a transient failure just defers the bind.
    await externalConnectorHealthCheck(siteId).catch((err) => {
      console.warn(
        `[wordpress:iwsl] post-confirm health.check for ${siteId} failed; canonical URL binds on the next sweep:`,
        err instanceof Error ? err.message : err,
      );
    });
    return json({ site });
  });
}

/**
 * POST — signed health.check to an external (§5) site over the HTTPS command
 * channel (§6 phase-4). Same wire objects and pinned-key verification as the
 * managed exec path, so a MITM is caught by the plugin/response verifier, not
 * trusted. Populates the site's connectorVersion for the update-available badge.
 * `wordpress:write` (a read-only probe of an already-linked site) and rate-
 * limited PER SITE so one slow endpoint can't be hammered.
 */
export async function externalHealthCheckHandler(siteId: string): Promise<NextResponse> {
  if (!SITE_ID_RE.test(siteId)) return fail("Invalid site id", 400);
  const gate = await authorize("wordpress:write");
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`ext-health-${siteId}`, gate.ctx.username, 20);
  if (limited) return limited;
  return guard(async () => json({ health: await externalConnectorHealthCheck(siteId) }));
}

/**
 * POST — operator re-confirm of an external link's identity after a §5
 * clone/identity-crisis alert. Admin: accepting a changed site URL re-opens the
 * state-changing ops, so it's a trust decision, not a read.
 */
const confirmIdentitySchema = z.object({ expectedAt: z.string().min(1).max(64) }).strict();

export async function confirmExternalIdentityHandler(req: NextRequest, siteId: string): Promise<NextResponse> {
  if (!SITE_ID_RE.test(siteId)) return fail("Invalid site id", 400);
  const gate = await authorize("wordpress:admin");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("confirm-identity", gate.ctx.username, 10);
  if (limited) return limited;
  const parsed = confirmIdentitySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("expectedAt (the reviewed alert timestamp) is required", 400);
  return guard(async () => json({ site: await confirmSiteIdentity(siteId, parsed.data.expectedAt) }));
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
  return guard(async () => {
    const [link, bundledConnectorVersion] = await Promise.all([
      getManagedLink(site),
      safeBundledConnectorVersion(),
    ]);
    return json({ link, bundledConnectorVersion });
  });
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

const OPS_ACTIONS = ["health", "debug", "rotate", "quarantine", "release", "deactivate", "update-plugin", "confirm-identity", "set-rotation-policy"] as const;
type OpsAction = (typeof OPS_ACTIONS)[number];

const opsSchema = z
  .object({
    action: z.enum(OPS_ACTIONS),
    // Anti-TOCTOU token for confirm-identity: the `identityAlert.at` the operator
    // reviewed. Ignored by other actions; required (and matched) for confirm.
    expectedIdentityAt: z.string().max(64).optional(),
    // Payload for set-rotation-policy. `intervalMs` is the age gate for this
    // link's scheduled reroll; schema-bounded to the safe ceiling here and
    // floor-clamped server-side. Omit it to auto-rotate on the fleet default.
    rotationPolicy: z
      .object({
        autoRotate: z.boolean(),
        intervalMs: z.number().int().positive().max(MAX_SITE_INTERVAL_MS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Diagnostics mutate only link bookkeeping; the rest change the trust state. */
const OPS_POLICY: Record<OpsAction, { permission: WordpressPermission; ratePerMin: number }> = {
  health: { permission: "wordpress:write", ratePerMin: 30 },
  debug: { permission: "wordpress:write", ratePerMin: 30 },
  rotate: { permission: "wordpress:admin", ratePerMin: 5 },
  quarantine: { permission: "wordpress:admin", ratePerMin: 10 },
  release: { permission: "wordpress:admin", ratePerMin: 10 },
  deactivate: { permission: "wordpress:admin", ratePerMin: 5 },
  "update-plugin": { permission: "wordpress:admin", ratePerMin: 5 },
  // Accepting a changed site identity re-opens the state-changing ops — admin.
  "confirm-identity": { permission: "wordpress:admin", ratePerMin: 10 },
  // Tuning key-rotation cadence is a security control — admin, same as rotate.
  "set-rotation-policy": { permission: "wordpress:admin", ratePerMin: 10 },
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
      case "confirm-identity": {
        const link = await getManagedLink(site);
        if (!link) return fail("This site has no connector link", 404);
        return json(await confirmSiteIdentity(link.siteId, parsed.data.expectedIdentityAt ?? ""));
      }
      case "set-rotation-policy": {
        if (!parsed.data.rotationPolicy) return fail("rotationPolicy payload is required", 400);
        const saved = await setRotationPolicy(site, parsed.data.rotationPolicy, gate.ctx.username);
        return json({ rotationPolicy: saved });
      }
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
function cronTokenValid(req: NextRequest, expected = process.env.WORDPRESS_HEALTH_CRON_TOKEN): boolean {
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
 * Constant-time compare of a `Authorization: Bearer <token>` header against the
 * metrics scrape token. Bearer is the Prometheus idiom (ServiceMonitor
 * `bearerTokenSecret`), so the exporter accepts it rather than the internal
 * cron header. Fail-closed: no configured token, or a missing/malformed/mismatched
 * header, all return false so an unconfigured deployment can't be scraped anonymously.
 */
function bearerTokenValid(req: NextRequest, expected = process.env.WORDPRESS_METRICS_TOKEN): boolean {
  if (!expected) return false;
  const header = req.headers.get("authorization");
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(match[1], "utf8");
  // timingSafeEqual throws on length mismatch — length itself is not secret.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * GET — Prometheus text exposition of the Connector fleet's signed telemetry
 * (`iwsl_connector_*`). Every series is sourced from a signed, pinned-key-verified
 * `metrics.snapshot`, so a scraped value is authenticated end-to-end — the scrape
 * surface itself is the ONLY new thing exposed on the console, and it is
 * token-gated. Authenticated by the Prometheus scrape token (`Authorization:
 * Bearer`, how the ServiceMonitor calls in) OR an operator session with
 * `wordpress:read`. Fail-closed on both. Served as text/plain, never cached.
 */
export async function connectorMetricsHandler(req: NextRequest): Promise<NextResponse | Response> {
  if (!bearerTokenValid(req)) {
    const gate = await authorize("wordpress:read");
    if (!gate.ok) return gate.error;
    const limited = rateLimited("metrics", gate.ctx.username, 30);
    if (limited) return limited;
  }
  try {
    const body = await exportConnectorMetrics();
    return new Response(body, {
      status: 200,
      headers: {
        // OpenMetrics/Prometheus text exposition content type.
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[wordpress:iwsl] metrics export error:", err instanceof Error ? err.message : err);
    return fail("Metrics export failed — check the server logs for details", 500);
  }
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

/**
 * POST — run the automated key-reroll sweep (§8). Authenticated exactly like the
 * health sweep: the in-cluster cron token (`x-internal-cron-token`, how the daily
 * CronJob calls in) OR an operator session. Unlike health-check reads, this rolls
 * live signing keys, so the operator fallback demands `wordpress:admin` (not
 * `write`) and the rate limit is tighter. Fail-closed on both.
 */
export async function rotationSweepHandler(req: NextRequest): Promise<NextResponse> {
  // Dedicated token — fleet key-rotation must not accept the read-only health
  // token (SECURITY-SCAN-2026-07-18 M2).
  if (!cronTokenValid(req, process.env.WORDPRESS_ROTATION_CRON_TOKEN)) {
    const gate = await authorize("wordpress:admin");
    if (!gate.ok) return gate.error;
    const limited = rateLimited("rotation-sweep", gate.ctx.username, 3);
    if (limited) return limited;
  }
  return guard(async () => json({ summary: await runRotationSweep() }));
}

// ── Fleet-wide Connector update (§5.1 maintenance) ───────────────────────────

/**
 * POST — reinstall the bundled Connector across every enrolled managed link in
 * one shot (the fleet version of the per-site `update-plugin` op). Operator-only
 * and namespace-wide admin: it pushes plugin code into every in-cluster site's
 * pod, so it is deliberately not driven by the health-sweep cron token — a bad
 * build must not auto-deploy fleet-wide unattended. Rate-limited hard.
 */
export async function connectorUpdateSweepHandler(): Promise<NextResponse> {
  const gate = await authorize("wordpress:admin");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("update-sweep", gate.ctx.username, 3);
  if (limited) return limited;
  return guard(async () => json({ summary: await runConnectorUpdateSweep() }));
}
