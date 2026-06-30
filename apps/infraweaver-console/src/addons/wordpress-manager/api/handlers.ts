import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
import {
  getWordpressAccessContext,
  hasWordpressPermission,
  getScopedWordpressSites,
  type WordpressPermission,
} from "../lib/wordpress-rbac";
import { isValidSiteName, isValidSiteId } from "../lib/naming";
import { PLUGIN_CATALOG } from "../lib/plugins";
import { listDomains, internalSubdomain, isAllowedDomain } from "../lib/config";
import { createSite, deleteSite, listSites, listInstalledPlugins, setPlugins, enableSso } from "../lib/provision";

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
    return fail("Operation failed — check the server logs for details", 500);
  }
}

const STORAGE_RE = /^[1-9]\d*[GMK]i$/;

const createSchema = z.object({
  // Subdomain — optional; empty/omitted means the root domain.
  name: z.string().refine((v) => v === "" || isValidSiteName(v), "invalid subdomain").optional(),
  domain: z.string().min(1, "domain is required"),
  internal: z.boolean().optional(),
  authMode: z.enum(["none", "admin", "full"]).optional(),
  plugins: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(50).optional(),
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

export async function listSitesHandler(): Promise<NextResponse> {
  const gate = await authorize("wordpress:read");
  if (!gate.ok) {
    // A user scoped to specific sites can still list those. Reuse the context the
    // gate already resolved rather than re-authenticating.
    if (!gate.ctx) return gate.error;
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
      wpStorage: parsed.data.wpStorage,
      dbStorage: parsed.data.dbStorage,
    });
    return json({ site: summary }, 201);
  });
}

/** Public-ish config for the create form: the domain dropdown + plugin catalog. */
export async function getConfigHandler(): Promise<NextResponse> {
  const gate = await authorize("wordpress:read");
  if (!gate.ok && !gate.ctx) return gate.error;
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
