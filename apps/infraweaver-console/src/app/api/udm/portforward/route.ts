/**
 * UDM port-forward + WAN API.
 *
 *   GET    ?wan=true   → WAN status (public IP + CGNAT), access-logged
 *   GET                → list port-forward rules (+ duplicate-name integrity)
 *   POST   {rule}      → upsert a rule (create or update-in-place)
 *   DELETE ?name=…     → delete a rule by name
 *
 * All mutations are wrapped in `logMutatingAccess` (raw HTTP access trail) and
 * `auditLog` (semantic action), and gated behind `infra:write`. Reads require
 * `infra:read`; the CGNAT/WAN read is additionally access-logged since it
 * reveals the WAN address.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { logAccess, logMutatingAccess, accessFieldsFromRequest } from "@/lib/access-log";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getUdmClientAsync } from "@/lib/udm/config";
import { UdmError } from "@/lib/udm/client";
import { findDuplicateNames, findDuplicateWanPorts } from "@/lib/udm/ports";
import { isValidRuleName, validatePortForwardRule } from "@/lib/udm/validate";

function udmErrorResponse(error: unknown): NextResponse {
  if (error instanceof UdmError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  const message = error instanceof Error ? error.message : "UDM request failed";
  return NextResponse.json({ error: message }, { status: 502 });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "infra:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const client = await getUdmClientAsync();
  if (!client) return NextResponse.json({ error: "UDM connector not configured" }, { status: 503 });

  const wantWan = new URL(req.url).searchParams.get("wan") === "true";
  try {
    if (wantWan) {
      // WAN read exposes the public IP → leave an access-trail line even though
      // it is a GET (logMutatingAccess intentionally no-ops on GET).
      logAccess(accessFieldsFromRequest(req, session.user?.email ?? "unknown"));
      return NextResponse.json(await client.getWanStatus());
    }
    // Fetch the rule set ONCE and derive the integrity reports locally. The
    // previous Promise.all issued three independent UDM reads; the cookie-auth
    // transport logs in per request, so concurrent logins clobbered each other's
    // session and the reads silently came back empty. One fetch → correct list.
    const rules = await client.listPortForwards();
    return NextResponse.json({
      rules,
      duplicates: findDuplicateNames(rules),
      portDuplicates: findDuplicateWanPorts(rules),
    });
  } catch (error) {
    return udmErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const actor = session?.user?.email ?? "unauthenticated";
  if (!session) {
    logMutatingAccess(req, actor, { status: 401 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "infra:write")) {
    logMutatingAccess(req, actor, { status: 403 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  logMutatingAccess(req, actor);
  if (!checkRateLimit(rateLimitKey("udm-portforward-upsert", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const client = await getUdmClientAsync();
  if (!client) return NextResponse.json({ error: "UDM connector not configured" }, { status: 503 });

  const body = await req.json().catch(() => null);
  const validation = validatePortForwardRule(body);
  if (!validation.ok || !validation.rule) {
    return NextResponse.json({ error: validation.error ?? "invalid rule" }, { status: 400 });
  }
  // Control flags live alongside the rule fields but are not part of the rule
  // itself; read them off the raw body after the rule is validated.
  const raw = (body ?? {}) as Record<string, unknown>;
  const autoAllocate = raw.autoAllocate === true;
  const keepFwdPortInSync = raw.keepFwdPortInSync === true;

  try {
    if (autoAllocate) {
      const alloc = await client.upsertPortForwardNoConflict(validation.rule, { keepFwdPortInSync });
      await auditLog(
        "udm:portforward:upsert",
        actor,
        `${alloc.action} port-forward ${validation.rule.name} (${validation.rule.proto} :${alloc.assignedPort} -> ${validation.rule.fwd}:${keepFwdPortInSync ? alloc.assignedPort : validation.rule.fwd_port})${alloc.bumped ? ` [bumped from :${alloc.requestedPort}]` : ""}`,
      );
      return NextResponse.json({ ok: true, ...alloc });
    }
    const result = await client.upsertPortForward(validation.rule);
    await auditLog(
      "udm:portforward:upsert",
      actor,
      `${result.action} port-forward ${validation.rule.name} (${validation.rule.proto} :${validation.rule.dst_port} -> ${validation.rule.fwd}:${validation.rule.fwd_port})`,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return udmErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  const actor = session?.user?.email ?? "unauthenticated";
  if (!session) {
    logMutatingAccess(req, actor, { status: 401 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "infra:write")) {
    logMutatingAccess(req, actor, { status: 403 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  logMutatingAccess(req, actor);
  if (!checkRateLimit(rateLimitKey("udm-portforward-delete", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const client = await getUdmClientAsync();
  if (!client) return NextResponse.json({ error: "UDM connector not configured" }, { status: 503 });

  const name = new URL(req.url).searchParams.get("name");
  if (!isValidRuleName(name)) return NextResponse.json({ error: "invalid name" }, { status: 400 });

  try {
    const result = await client.deletePortForward(name);
    await auditLog("udm:portforward:delete", actor, `${result.action} port-forward ${name}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return udmErrorResponse(error);
  }
}
