import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { loadClusterEvents } from "@/lib/ops-data";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["apps:read", "cluster:read", "infra:read", "security:read", "config:read"])) {
    return NextResponse.json({ notifications: [], counts: { warning: 0, error: 0 }, live: false });
  }

  const { events, live } = await loadClusterEvents(40);
  const notifications = events
    .filter((event) => event.type === "Warning")
    .map((event) => ({
      id: event.id,
      title: `${event.reason} · ${event.involvedObject.kind}/${event.involvedObject.name}`,
      body: `${event.namespace}: ${event.message}`,
      level: event.level === "error" ? "error" : "warning",
      timestamp: new Date(event.lastSeen ?? event.firstSeen ?? Date.now()).getTime(),
      read: false,
    }))
    .slice(0, 20);

  return NextResponse.json({
    notifications,
    counts: {
      warning: notifications.filter((notification) => notification.level === "warning").length,
      error: notifications.filter((notification) => notification.level === "error").length,
    },
    live,
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json() as { title?: string; body?: string; level?: string };
  const { title, body: notifBody, level = "info" } = body;

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    notification: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      body: notifBody,
      level,
      timestamp: Date.now(),
      read: false,
    },
  });
}
