import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const res = await iwApiFetch("/cluster/pdbs", session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
