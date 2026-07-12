import { NextResponse } from "next/server";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { loadClusterEvents } from "@/lib/ops-data";
import { withAuth } from "@/lib/with-auth";

// Auth-only wrapper: a reader without any read permission still gets a 200
// with an EMPTY payload (the notification bell renders quietly) — never a 403.
export const GET = withAuth({}, async ({ session }) => {
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
});
