import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { apps, cacheStatus } = await getArgocdAppsCached();
  return NextResponse.json(apps, {
    headers: { "X-Cache": cacheStatus },
  });
}
