import { NextResponse } from "next/server";
import { auditLog, redactAuditDetail } from "@/lib/audit-log";
import { makeCoreApi } from "@/lib/kube-client";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import type { AuditEntry } from "@/lib/security/types";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const NAMESPACE = "infraweaver-console";
const CONFIGMAP_NAME = "infra-console-audit-log";
const MAX_ENTRIES = 200;

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

function requestUserAgent(req?: Pick<Request, "headers">) {
  return req?.headers.get("user-agent")?.trim() || undefined;
}

function normalizeAuditEntry(entry: Partial<AuditEntry>): AuditEntry | null {
  if (!entry.timestamp || !entry.action || !entry.user) return null;
  return {
    timestamp: entry.timestamp,
    user: entry.user,
    action: entry.action,
    resource: entry.resource ?? "",
    details: redactAuditDetail(entry.details ?? ""),
    result: entry.result === "failure" ? "failure" : "success",
    ip: entry.ip,
    userAgent: entry.userAgent,
  };
}

async function readStoredEntries() {
  const coreApi = makeCoreApi();
  const cm = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
  const log = (cm as { data?: Record<string, string> }).data?.log ?? "";
  return log
    .split("\n")
    .filter(Boolean)
    .slice(-MAX_ENTRIES)
    .map((line) => {
      try {
        return normalizeAuditEntry(JSON.parse(line) as Partial<AuditEntry>);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is AuditEntry => entry !== null)
    .reverse();
}

async function appendAuditEntry(entry: AuditEntry) {
  const coreApi = makeCoreApi();

  let existingLog = "";
  try {
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
    existingLog = (cm as { data?: Record<string, string> }).data?.log ?? "";
  } catch {
    existingLog = "";
  }

  const lines = existingLog.split("\n").filter(Boolean);
  lines.push(JSON.stringify(entry));
  const newLog = `${lines.slice(-MAX_ENTRIES).join("\n")}\n`;

  try {
    await coreApi.patchNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: NAMESPACE,
      body: { data: { log: newLog } },
    });
  } catch {
    await coreApi.createNamespacedConfigMap({
      namespace: NAMESPACE,
      body: {
        metadata: { name: CONFIGMAP_NAME, namespace: NAMESPACE },
        data: { log: newLog },
      },
    });
  }
}

export const GET = withRoute("security:read", async () => {
  try {
    const entries = await readStoredEntries();
    return NextResponse.json({ entries }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ entries: [] as AuditEntry[] }, {
      headers: { "Cache-Control": "no-store" },
    });
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

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    user: session.user?.email ?? "unknown",
    action: parsed.data.action,
    resource: parsed.data.resource,
    details: redactAuditDetail(parsed.data.details),
    result: parsed.data.result,
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
  };

  try {
    await appendAuditEntry(entry);
    await auditLog(entry.action, entry.user, entry.details || `${entry.action} ${entry.resource}`.trim(), {
      result: entry.result,
      resource: entry.resource || undefined,
      ip: entry.ip,
      userAgent: entry.userAgent,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
