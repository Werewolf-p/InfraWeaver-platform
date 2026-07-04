import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { AddonHttpError } from "../lib/errors";
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
 * name provisioned cluster sites and don't map onto link records.
 */
async function authorize(permission: WordpressPermission): Promise<AuthzResult> {
  const session = await auth();
  if (!session) return { ok: false, error: fail("Unauthorized", 401), ctx: null };
  const ctx = await getWordpressAccessContext(session);
  if (!hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, "")) {
    return { ok: false, error: fail("Forbidden", 403), ctx };
  }
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
