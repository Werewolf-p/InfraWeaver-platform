import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import fs from "fs";

interface AuthEvent {
  id: string;
  timestamp: string;
  action: string;
  user: string;
  ip: string;
  success: boolean;
  details?: string;
}

function generateMockEvents(): AuthEvent[] {
  const now = Date.now();
  return [
    { id: "evt-1", timestamp: new Date(now - 120000).toISOString(), action: "login", user: "admin@infraweaver.local", ip: "10.0.1.42", success: true, details: "OIDC login via Authentik" },
    { id: "evt-2", timestamp: new Date(now - 340000).toISOString(), action: "login", user: "unknown@example.com", ip: "185.220.101.5", success: false, details: "Invalid credentials" },
    { id: "evt-3", timestamp: new Date(now - 600000).toISOString(), action: "login", user: "operator@infraweaver.local", ip: "10.0.1.55", success: true, details: "OIDC login via Authentik" },
    { id: "evt-4", timestamp: new Date(now - 900000).toISOString(), action: "token_refresh", user: "admin@infraweaver.local", ip: "10.0.1.42", success: true },
    { id: "evt-5", timestamp: new Date(now - 1200000).toISOString(), action: "login", user: "root", ip: "185.220.101.6", success: false, details: "Brute force attempt" },
    { id: "evt-6", timestamp: new Date(now - 1800000).toISOString(), action: "logout", user: "operator@infraweaver.local", ip: "10.0.1.55", success: true },
    { id: "evt-7", timestamp: new Date(now - 2700000).toISOString(), action: "login", user: "admin@infraweaver.local", ip: "10.0.1.42", success: true, details: "OIDC login via Authentik" },
  ];
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
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Try Authentik API first, then audit log, then mock
  const authentikEvents = await fetchAuthentikEvents();
  if (authentikEvents && authentikEvents.length > 0) {
    return NextResponse.json({ events: authentikEvents, source: "authentik" });
  }

  const logEvents = readAuditLog();
  if (logEvents.length > 0) {
    return NextResponse.json({ events: logEvents, source: "audit-log" });
  }

  return NextResponse.json({ events: generateMockEvents(), source: "mock" });
}
