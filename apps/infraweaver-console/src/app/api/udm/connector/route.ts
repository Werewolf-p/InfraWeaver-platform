/**
 * UDM connector configuration API.
 *
 *   GET   → connector status (configured? host? source) — never returns creds
 *   POST  {host, username, password} → validate host, capture+pin the cert
 *          (TOFU), test the credentials against the live gateway, then persist to
 *          OpenBao. A blank password keeps the stored one (host/username update).
 *
 * This firmware rejects API keys on the local Network API, so the connector uses
 * UniFi OS username/password (cookie) auth. Reads require `infra:read`; the write
 * is gated on `infra:write`, rate-limited, access-logged and audited. The
 * password is never logged.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { logMutatingAccess } from "@/lib/access-log";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { buildUdmClient, isUdmConfigured } from "@/lib/udm/config";
import { readStoredUdmConfig, writeStoredUdmConfig } from "@/lib/udm/store";
import { fetchServerFingerprint } from "@/lib/udm/tofu";
import type { UdmConfig } from "@/lib/udm/types";

/** Normalize an operator-supplied host into a bare `https://host[:port]` origin,
 *  or null when it is not a plain https gateway address. */
function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const host = url.hostname;
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split(".").every((p) => Number(p) <= 255);
  const isDns = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/i.test(host);
  if (!isIpv4 && !isDns) return null;
  return url.port ? `https://${host}:${url.port}` : `https://${host}`;
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "infra:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const stored = await readStoredUdmConfig().catch(() => null);
  const envConfigured = isUdmConfigured();
  return NextResponse.json({
    configured: Boolean(stored) || envConfigured,
    host: stored?.host ?? process.env.UDM_HOST ?? "",
    username: stored?.username ?? "",
    site: stored?.site ?? process.env.UDM_SITE ?? "default",
    source: stored ? "openbao" : envConfigured ? "env" : "none",
  });
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
  if (!checkRateLimit(rateLimitKey("udm-connector-save", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { host?: unknown; username?: unknown; password?: unknown; site?: unknown }
    | null;

  const host = normalizeHost(body?.host);
  if (!host) return NextResponse.json({ error: "invalid host" }, { status: 400 });

  if (!isNonEmptyString(body?.username, 128)) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }
  const username = (body.username as string).trim();

  const rawPassword = typeof body?.password === "string" ? body.password : "";
  let password = rawPassword;
  if (!password) {
    // Blank password on an already-configured connector = host/username update:
    // reuse the stored password.
    const existing = await readStoredUdmConfig().catch(() => null);
    if (!existing) return NextResponse.json({ error: "password required" }, { status: 400 });
    password = existing.password;
  } else if (!isNonEmptyString(password, 256)) {
    return NextResponse.json({ error: "invalid password" }, { status: 400 });
  }

  const site = typeof body?.site === "string" && body.site.trim() ? body.site.trim() : "default";

  // Establish the cert pin against the given host (TOFU), then prove the
  // credentials work before persisting anything.
  let fingerprintSha256: string;
  try {
    fingerprintSha256 = await fetchServerFingerprint(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TLS connect failed";
    return NextResponse.json({ error: `could not reach UDM at ${host}: ${message}` }, { status: 502 });
  }

  const config: UdmConfig = { host, username, password, fingerprintSha256, site };
  try {
    const wan = await buildUdmClient(config).getWanStatus();
    await writeStoredUdmConfig({ host, username, password, fingerprintSha256, site });
    await auditLog("udm:connector:configure", actor, `set UDM connector host=${host} user=${username} site=${site}`);
    return NextResponse.json({ ok: true, configured: true, host, wanIp: wan.wanIp, isCgnat: wan.isCgnat });
  } catch (error) {
    const message = error instanceof Error ? error.message : "connector test failed";
    return NextResponse.json({ error: `connector test failed: ${message}` }, { status: 502 });
  }
}
