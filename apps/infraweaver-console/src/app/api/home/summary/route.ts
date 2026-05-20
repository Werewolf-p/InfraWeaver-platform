import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadHomeDashboardSummary } from "@/lib/home-dashboard";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  const summary = await loadHomeDashboardSummary({
    includeArgocdSummary: hasSessionPermission(access, "apps:read"),
    includeEvents: hasAnySessionPermission(access, ["apps:read", "cluster:read", "infra:read"]),
  });

  return NextResponse.json(summary, {
    headers: { "Cache-Control": "no-store" },
  });
}
