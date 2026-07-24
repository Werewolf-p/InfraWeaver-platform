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
  EMAIL_WRITE_VERBS,
  emailConfigSetParamsSchema,
  emailTestParamsSchema,
  type EmailWriteVerb,
} from "../lib/manage/email";
import { clearEmailLog, sendTestEmail, setEmailConfig } from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the Email panel's WRITE verbs. Every verb is a
 * state change, so all require `wordpress:write` (config.set, which writes an SMTP
 * credential, requires `wordpress:admin`), a same-origin check (CSRF), a rate
 * limit, and an audit line. NO unsigned/public endpoint — each verb delegates to a
 * signed `email.*` op the plugin's verifier enforces (the signed-channel
 * invariant). Reads are served by the merged panel probe.
 *
 * SECURITY — SECRET HANDLING: `email.config.set` carries a WRITE-ONLY password.
 * It rides the signed envelope to the site and is NEVER logged: the audit line
 * below records only the host/verb, never the request body. The connector reply
 * is already stripped of the secret. Grep invariant: no password reaches any log
 * line on this path.
 */

const RATE_WINDOW_MS = 60_000;

/** Per-verb rate ceiling. `test` is generous but the connector clamps sends to 1/30s regardless. */
const WRITE_RATE: Record<EmailWriteVerb, number> = { config: 30, test: 30, "clear-log": 30 };

/** config.set writes a credential ⇒ admin; test/clear-log ⇒ write. */
const WRITE_PERMISSION: Record<EmailWriteVerb, WordpressPermission> = {
  config: "wordpress:admin",
  test: "wordpress:write",
  "clear-log": "wordpress:write",
};

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
  if (!checkRateLimit(`wordpress:email-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors media-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:email] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail(
        "The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.",
        502,
      );
    }
    return fail("Email operation failed — check the server logs for details", 500);
  }
}

function isWriteVerb(v: string): v is EmailWriteVerb {
  return (EMAIL_WRITE_VERBS as readonly string[]).includes(v);
}

/** POST — a write verb: `{ verb, params }`. RBAC + same-origin + rate-limit + redacted audit. */
export async function emailWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing email op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown email action", 400);

  const gate = await authorize(WRITE_PERMISSION[verb], site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(verb, gate.username, WRITE_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    switch (verb) {
      case "config": {
        const parsed = emailConfigSetParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid email.config.set parameters", 400);
        const result = await setEmailConfig(site, parsed.data);
        // AUDIT: host + whether a secret was touched — NEVER the password itself.
        const secretTouched = parsed.data.password !== undefined || parsed.data.clear_password === true;
        await auditLog(
          "wordpress:email-config",
          gate.username,
          `site ${site} set SMTP host ${parsed.data.settings.host}:${parsed.data.settings.port}${secretTouched ? " (credential updated)" : ""}`,
          { result: result.ok ? "success" : "failure", resource: `wordpress/${site}` },
        );
        return json(result);
      }
      case "test": {
        const parsed = emailTestParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid email.test parameters", 400);
        const result = await sendTestEmail(site, parsed.data);
        await auditLog("wordpress:email-test", gate.username, `site ${site} test send to ${parsed.data.to}`, {
          result: result.sent ? "success" : "failure",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "clear-log": {
        const result = await clearEmailLog(site);
        await auditLog("wordpress:email-clear-log", gate.username, `site ${site} clear delivery log`, {
          result: result.ok ? "success" : "failure",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
    }
  });
}
