import { NextResponse } from "next/server";
import { loadHomeDashboardSummary } from "@/lib/home-dashboard";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({}, async ({ session }) => {
  const access = await getSessionRBACContext(session, 60);
  const summary = await loadHomeDashboardSummary({
    includeArgocdSummary: hasSessionPermission(access, "apps:read"),
    includeEvents: hasAnySessionPermission(access, ["apps:read", "cluster:read", "infra:read"]),
  });

  return NextResponse.json(summary, {
    headers: { "Cache-Control": "no-store" },
  });
});
