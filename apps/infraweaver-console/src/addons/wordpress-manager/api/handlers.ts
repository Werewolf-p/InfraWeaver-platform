import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
import { WpPodExecError } from "../lib/k8s-exec";
import {
  getWordpressAccessContext,
  hasWordpressPermission,
  getScopedWordpressSites,
  hasAllWordpressAccess,
  WORDPRESS_NAMESPACE,
  type WordpressPermission,
} from "../lib/wordpress-rbac";
import { isValidSiteName, isValidSiteId } from "../lib/naming";
import { PLUGIN_CATALOG } from "../lib/plugins";
import { listDomains, internalSubdomain, isAllowedDomain } from "../lib/config";
import { createSite, deleteSite, listSites, listSitePods, listInstalledPlugins, setPlugins, updateAllPlugins, getMaintenanceMode, setMaintenanceMode, enableSso, setProtection, getSiteHealth, syncSiteWpUsers } from "../lib/provision";
import { ensureSiteAccess, listSiteAccessUsers, siteAccessGroupName } from "../lib/access";
import { computeSiteWordpressUsers } from "../lib/access-policy";
import { loadUsersConfig } from "@/lib/users-config";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Resolve the session and assert a WordPress permission. For a specific site the
 * check honours both the namespace-wide grant and a per-site scope; the platform
 * owner/admin always passes (handled inside hasWordpressPermission).
 */
type AccessContext = Awaited<ReturnType<typeof getWordpressAccessContext>>;
type AuthzResult =
  | { ok: false; error: NextResponse; ctx: AccessContext | null }
  | { ok: true; ctx: AccessContext };

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

/**
 * Per-user sliding-window limit on a mutation. Authenticated endpoints key on the
 * username (falling back to a constant) rather than IP, so a single user can't
 * hammer the k8s/vault/DNS control plane.
 */
function rateLimited(action: string, user: string, max: number): NextResponse | null {
  if (!checkRateLimit(`wordpress:${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/**
 * Run a provisioning action, turning any thrown error into a structured 500. The
 * full error (which can carry vault paths or k8s resource names) is logged
 * server-side only; the client gets a generic message so internal topology is not
 * disclosed to scoped users.
 */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress] handler error:", err instanceof Error ? err.message : err);
    // Typed domain errors carry a safe message + status (404 missing site, 503
    // pod/vault not ready); everything else is generic so internals aren't leaked.
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    // A wp-cli exec that exited non-zero is almost always the site's WordPress or
    // its database briefly not answering — say so (and say "retry") instead of an
    // opaque 500. The stderr detail stays in the server log above, not the client.
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond as expected — its database or pod may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Operation failed — check the server logs for details", 500);
  }
}

const STORAGE_RE = /^[1-9]\d*[GMK]i$/;

const createSchema = z.object({
  // Subdomain — optional; empty/omitted means the root domain.
  name: z.string().refine((v) => v === "" || isValidSiteName(v), "invalid subdomain").optional(),
  domain: z.string().min(1, "domain is required"),
  internal: z.boolean().optional(),
  authMode: z.enum(["none", "login", "admin", "full"]).optional(),
  plugins: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(50).optional(),
  connector: z.boolean().optional(),
  wpStorage: z.string().regex(STORAGE_RE, "storage must be a positive size like 5Gi").optional(),
  dbStorage: z.string().regex(STORAGE_RE, "storage must be a positive size like 5Gi").optional(),
}).strict();

const pluginsSchema = z.object({
  plugins: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(50),
}).strict();

const ssoSchema = z.object({
  issuerBase: z.string().url().refine(
    (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } },
    "issuerBase must be an https URL",
  ),
}).strict();

const protectionSchema = z.object({
  authMode: z.enum(["none", "login", "admin", "full"]),
}).strict();

const maintenanceSchema = z.object({
  enabled: z.boolean(),
}).strict();

export async function listSitesHandler(): Promise<NextResponse> {
  const gate = await authorize("wordpress:read");
  if (!gate.ok) {
    // A user scoped to specific sites can still list those. Reuse the context the
    // gate already resolved rather than re-authenticating.
    if (!gate.ctx) return gate.error;
    // A blanket "/wordpress" (resource-group) grant cascades to every site.
    if (hasAllWordpressAccess(gate.ctx.roleAssignments)) {
      return guard(async () => json({ sites: await listSites() }));
    }
    const allowed = new Set(getScopedWordpressSites(gate.ctx.roleAssignments));
    if (allowed.size === 0) return gate.error;
    return guard(async () => {
      const sites = await listSites();
      return json({ sites: sites.filter((s) => allowed.has(s.site)) });
    });
  }
  return guard(async () => json({ sites: await listSites() }));
}

export async function createSiteHandler(req: NextRequest): Promise<NextResponse> {
  const gate = await authorize("wordpress:write");
  if (!gate.ok) return gate.error;
  const limited = rateLimited("create", gate.ctx.username, 10);
  if (limited) return limited;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  return guard(async () => {
    if (!(await isAllowedDomain(parsed.data.domain))) return fail("unknown domain", 400);
    const summary = await createSite({
      name: parsed.data.name ?? "",
      domain: parsed.data.domain,
      internal: parsed.data.internal ?? false,
      authMode: parsed.data.authMode ?? "none",
      plugins: parsed.data.plugins,
      connector: parsed.data.connector,
      wpStorage: parsed.data.wpStorage,
      dbStorage: parsed.data.dbStorage,
    });
    return json({ site: summary }, 201);
  });
}

/** Config for the create form: the domain dropdown + plugin catalog. */
export async function getConfigHandler(): Promise<NextResponse> {
  const gate = await authorize("wordpress:read");
  if (!gate.ok) {
    if (!gate.ctx) return gate.error;
    // Mirror listSitesHandler: a blanket "/wordpress" grant gets the full config;
    // users scoped to specific sites get only the plugin catalog — the managed
    // domain list and internal gating subdomain are infrastructure topology and
    // stay withheld. Sessions with zero wordpress grants are refused outright.
    if (!hasAllWordpressAccess(gate.ctx.roleAssignments)) {
      const scoped = getScopedWordpressSites(gate.ctx.roleAssignments);
      if (scoped.length === 0) return gate.error;
      return json({ domains: [], defaultDomain: "", internalSubdomain: "", catalog: PLUGIN_CATALOG });
    }
  }
  return guard(async () => {
    const domains = await listDomains();
    return json({
      domains,
      defaultDomain: domains[0] ?? "",
      internalSubdomain: internalSubdomain(),
      catalog: PLUGIN_CATALOG,
    });
  });
}

export async function deleteSiteHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:admin", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("delete", gate.ctx.username, 10);
  if (limited) return limited;
  return guard(async () => {
    await deleteSite(site);
    return json({ ok: true });
  });
}

export async function getPluginsHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  // Distinguish "no plugins" from "pod exec failed" so the UI never treats a
  // transient pod failure as an empty install set and tears plugins out.
  try {
    const installed = await listInstalledPlugins(site);
    return json({ catalog: PLUGIN_CATALOG, installed, installedError: null });
  } catch (err) {
    console.error("[wordpress] listInstalledPlugins failed for", site, err instanceof Error ? err.message : err);
    // Only surface the safe message of a typed domain error (e.g. "pod not running
    // yet"); raw k8s/exec errors can carry pod names, so they stay server-side.
    const installedError = err instanceof AddonHttpError ? err.message : "Could not read plugins — check the server logs";
    return json({ catalog: PLUGIN_CATALOG, installed: null, installedError });
  }
}

export async function setPluginsHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("plugins", gate.ctx.username, 20);
  if (limited) return limited;
  const parsed = pluginsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Invalid plugin list", 400);
  return guard(async () => json(await setPlugins(site, parsed.data.plugins)));
}

/** POST — update every installed plugin to its latest version (one wp-cli pass). */
export async function updatePluginsHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("plugins-update", gate.ctx.username, 10);
  if (limited) return limited;
  return guard(async () => json(await updateAllPlugins(site)));
}

/** GET — whether the maintenance page is currently active for the site. */
export async function getMaintenanceHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("maintenance-read", gate.ctx.username, 60);
  if (limited) return limited;
  return guard(async () => json({ site, ...(await getMaintenanceMode(site)) }));
}

/** PUT — turn the maintenance page on or off. */
export async function setMaintenanceHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("maintenance", gate.ctx.username, 20);
  if (limited) return limited;
  const parsed = maintenanceSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Invalid maintenance request", 400);
  return guard(async () => json({ site, ...(await setMaintenanceMode(site, parsed.data.enabled)) }));
}

export async function enableSsoHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("sso", gate.ctx.username, 10);
  if (limited) return limited;
  const parsed = ssoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("A valid Authentik issuer URL is required", 400);
  return guard(async () => {
    // Edge gate + OIDC are provisioned through the reusable `ensureSsoGate`
    // capability (live Authentik REST API), not a blueprint ConfigMap.
    await enableSso(site, { issuerBase: parsed.data.issuerBase });
    return json({ ok: true });
  });
}

/**
 * Who InfraWeaver currently authorizes to sign into a site (the exact set the
 * Authentik access group is reconciled to). Read-access to the site is enough to
 * view its member list; changing membership is done through RBAC, not here.
 */
export async function getAccessHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("access-read", gate.ctx.username, 60);
  if (limited) return limited;
  return guard(async () => {
    const cfg = await loadUsersConfig();
    const desired = computeSiteWordpressUsers(site, cfg.users, cfg.groups);
    // roles: the WordPress role each allowed user gets from their RBAC grant.
    const roles = Object.fromEntries(desired.users.map((user) => [user.username, user.role]));
    return json({
      group: siteAccessGroupName(site),
      allowed: await listSiteAccessUsers(site),
      roles,
      skippedNoEmail: desired.skippedNoEmail,
    });
  });
}

/**
 * GET — the live pods behind a site (WordPress + MariaDB). Read access to the
 * site is enough: this only exposes the site's own runtime, discovered via the
 * per-site label, never other namespaces' pods.
 */
export async function getSitePodsHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("pods-read", gate.ctx.username, 60);
  if (limited) return limited;
  return guard(async () => json({ site, namespace: WORDPRESS_NAMESPACE, pods: await listSitePods(site) }));
}

/** GET — read-only Site Health snapshot (WP/PHP versions, DB size, plugins, uploads). */
export async function getHealthHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("health-read", gate.ctx.username, 60);
  if (limited) return limited;
  return guard(async () => json({ site, health: await getSiteHealth(site) }));
}

/**
 * Force a reconcile of the site's Authentik access group to the current RBAC-derived
 * member set (self-heals after a transient failure of the automatic grant/revoke
 * sync). Requires admin on the site — it mutates who can authenticate to it.
 */
export async function syncAccessHandler(site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:admin", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("access-sync", gate.ctx.username, 10);
  if (limited) return limited;
  return guard(async () => {
    const result = await ensureSiteAccess(site);
    // Also materialize the grants as WordPress accounts. Reported separately and
    // non-fatal: the Authentik reconcile above is the security control, while the
    // pod may simply not be running yet.
    let wordpressUsers:
      | { actions: unknown[]; skippedNoEmail: string[]; failed: { username: string; reason: string }[] }
      | { error: string };
    try {
      wordpressUsers = await syncSiteWpUsers(site);
    } catch (err) {
      console.warn(`[wordpress] user sync for ${site} failed:`, err instanceof Error ? err.message : err);
      wordpressUsers = { error: err instanceof AddonHttpError ? err.message : "WordPress user sync failed — check the server logs" };
    }
    return json({ group: siteAccessGroupName(site), ...result, wordpressUsers });
  });
}

/**
 * Change a site's Authentik protection scope (none | login | admin | full).
 * Admin on the site is required — it changes what the public can reach.
 */
export async function setProtectionHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const gate = await authorize("wordpress:admin", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited("protection", gate.ctx.username, 20);
  if (limited) return limited;
  const parsed = protectionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("authMode must be one of: none, login, admin, full", 400);
  return guard(async () => json({ site: await setProtection(site, parsed.data.authMode) }));
}
