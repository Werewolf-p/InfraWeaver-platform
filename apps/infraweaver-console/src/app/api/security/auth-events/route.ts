import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import fs from "node:fs";

interface AuthEvent {
  id: string;
  timestamp: string;
  action: string;
  user: string;
  ip: string;
  success: boolean;
  details?: string;
}

async function fetchAuthentikEvents(): Promise<AuthEvent[] | null> {
  const authentikUrl = process.env.AUTHENTIK_URL;
  const authentikToken = process.env.AUTHENTIK_TOKEN;
  if (!authentikUrl || !authentikToken) return null;

  try {
    const res = await fetch(`${authentikUrl}/api/v3/events/events/?action=login&page_size=20`, {
      headers: { Authorization: `Bearer ${authentikToken}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      results?: Array<{
        pk?: string;
        created?: string;
        action?: string;
        user?: { username?: string; on_behalf_of?: { username?: string } };
        client_ip?: string;
        context?: { successful?: boolean; http_request?: { path?: string } };
      }>;
    };
    return (data.results ?? []).map(evt => ({
      id: evt.pk ?? crypto.randomUUID(),
      timestamp: evt.created ?? new Date().toISOString(),
      action: evt.action ?? "unknown",
      user: evt.user?.username ?? evt.user?.on_behalf_of?.username ?? "unknown",
      ip: evt.client_ip ?? "unknown",
      success: evt.context?.successful !== false,
      details: evt.context?.http_request?.path,
    }));
  } catch {
    return null;
  }
}

function readAuditLog(): AuthEvent[] {
  const logPath = process.env.INFRAWEAVER_AUDIT_LOG ?? "/var/log/infraweaver-audit.log";
  try {
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).slice(-50);
    return lines.map((line, i) => {
      try {
        return JSON.parse(line) as AuthEvent;
      } catch {
        return {
          id: `log-${i}`,
          timestamp: new Date().toISOString(),
          action: "unknown",
          user: "unknown",
          ip: "unknown",
          success: true,
          details: line.slice(0, 100),
        };
      }
    }).reverse();
  } catch {
    return [];
  }
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const authentikEvents = await fetchAuthentikEvents();
  if (authentikEvents && authentikEvents.length > 0) {
    return NextResponse.json({ events: authentikEvents, source: "authentik" }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const logEvents = readAuditLog();
  return NextResponse.json({ events: logEvents, source: logEvents.length ? "audit-log" : "unavailable" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
