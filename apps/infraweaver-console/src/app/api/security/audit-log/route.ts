import { NextResponse } from "next/server";
import { auditLog, redactAuditDetail } from "@/lib/audit-log";
import { queryAudit } from "@/lib/audit/store";
import type { AuditRecord } from "@/lib/audit/types";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import type { AuditEntry } from "@/lib/security/types";
import { safeError } from "@/lib/utils";
import { z } from "zod";

// Legacy shape/window preserved for the existing security page. Reads now come
// from the SAME durable store the 108 auditLog() sites write to, so this view
// (previously near-empty) is populated.
const LEGACY_WINDOW = 200;

const CreateAuditEntryBody = z.object({
  action: z.string().trim().min(3).max(128),
  resource: z.string().trim().max(256).optional().default(""),
  details: z.string().trim().max(4096).optional().default(""),
  result: z.enum(["success", "failure"]).optional().default("success"),
});

function requestIp(req?: Pick<Request, "headers">) {
  if (!req) return undefined;
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || undefined;
}

function toLegacyEntry(record: AuditRecord): AuditEntry {
  return {
    timestamp: record.timestamp,
    user: record.user,
    action: record.action,
    resource: record.resource ?? "",
    details: record.detail,
    result: record.result,
    ip: record.ip,
    userAgent: record.userAgent,
    category: record.category,
    severity: record.severity,
    target: record.target,
    seq: record.seq,
  };
}

export const GET = withRoute("security:read", async () => {
  try {
    const page = await queryAudit({ limit: LEGACY_WINDOW });
    return NextResponse.json(
      { entries: page.entries.map(toLegacyEntry) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ entries: [] as AuditEntry[] }, { headers: { "Cache-Control": "no-store" } });
  }
});

export const POST = withRoute("security:write", async (req, session) => {
  if (!checkRateLimit(rateLimitKey("security-audit-log", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = CreateAuditEntryBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const user = session.user?.email ?? "unknown";
  const details = redactAuditDetail(parsed.data.details) || `${parsed.data.action} ${parsed.data.resource}`.trim();

  try {
    // Single durable write path: auditLog() now appends to the store.
    await auditLog(parsed.data.action, user, details, {
      result: parsed.data.result,
      resource: parsed.data.resource || undefined,
      ip: requestIp(req),
      userAgent: req.headers.get("user-agent")?.trim() || undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
