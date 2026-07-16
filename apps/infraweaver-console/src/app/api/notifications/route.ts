import { NextResponse } from "next/server";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { loadClusterEvents } from "@/lib/ops-data";
import { eventsToSignals } from "@/lib/notifications/app-mapping";
import { buildNotifications } from "@/lib/notifications/pipeline";
import { withAuth } from "@/lib/with-auth";

// Auth-only wrapper: a reader without any read permission still gets a 200
// with an EMPTY payload (the notification bell renders quietly) — never a 403.
export const GET = withAuth({}, async ({ session }) => {
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["apps:read", "cluster:read", "infra:read", "security:read", "config:read"])) {
    return NextResponse.json({ notifications: [], counts: { warning: 0, error: 0 }, live: false });
  }

  // Raw Warning events → signals → dedup/group/severity/rate-limit pipeline, so
  // a flapping pod collapses into ONE grouped notification instead of a storm.
  const { events, live } = await loadClusterEvents(40);
  const notifications = buildNotifications(eventsToSignals(events));

  return NextResponse.json({
    notifications,
    counts: {
      warning: notifications.filter((notification) => notification.severity === "warning").length,
      error: notifications.filter((notification) => notification.severity === "critical").length,
    },
    live,
  });
});
