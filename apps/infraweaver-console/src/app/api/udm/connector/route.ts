/**
 * UDM connector configuration API.
 *
 *   GET   → connector status (configured? host? source) — never returns the key
 *   POST  {host, apiKey} → validate host, capture+pin the cert (TOFU), test the
 *          key against the live gateway, then persist to OpenBao. A blank apiKey
 *          keeps the stored key (host-only update).
 *
 * Reads require `infra:read`; the write is gated on `infra:write`, rate-limited,
 * access-logged and audited. The API key value is never logged.
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

/** A UniFi OS API key is a long opaque token; reject obviously-wrong input. */
function isPlausibleApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 512 && !/\s/.test(value);
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

  const body = (await req.json().catch(() => null)) as { host?: unknown; apiKey?: unknown; site?: unknown } | null;

  const host = normalizeHost(body?.host);
  if (!host) return NextResponse.json({ error: "invalid host" }, { status: 400 });

  const rawKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  let apiKey = rawKey;
  if (!apiKey) {
    // Blank key on an already-configured connector = host-only update: reuse the stored key.
    const existing = await readStoredUdmConfig().catch(() => null);
    if (!existing) return NextResponse.json({ error: "apiKey required" }, { status: 400 });
    apiKey = existing.apiKey;
  } else if (!isPlausibleApiKey(apiKey)) {
    return NextResponse.json({ error: "invalid apiKey" }, { status: 400 });
  }

  const site = typeof body?.site === "string" && body.site.trim() ? body.site.trim() : "default";

  // Establish the cert pin against the given host (TOFU), then prove the key
  // works before persisting anything.
  let fingerprintSha256: string;
  try {
    fingerprintSha256 = await fetchServerFingerprint(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TLS connect failed";
    return NextResponse.json({ error: `could not reach UDM at ${host}: ${message}` }, { status: 502 });
  }

  const config: UdmConfig = { host, apiKey, fingerprintSha256, site };
  try {
    const wan = await buildUdmClient(config).getWanStatus();
    await writeStoredUdmConfig({ host, apiKey, fingerprintSha256, site });
    await auditLog("udm:connector:configure", actor, `set UDM connector host=${host} site=${site}`);
    return NextResponse.json({ ok: true, configured: true, host, wanIp: wan.wanIp, isCgnat: wan.isCgnat });
  } catch (error) {
    const message = error instanceof Error ? error.message : "connector test failed";
    return NextResponse.json({ error: `connector test failed: ${message}` }, { status: 502 });
  }
}
