import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { iwApiFetch } from "@/lib/iw-api";

/** GET /api/longhorn/backups — list Longhorn backup volumes via infraweaver-api */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) {
    return NextResponse.json({ error: "Forbidden: cluster:read required" }, { status: 403 });
  }

  const res = await iwApiFetch("/longhorn/backups", session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
