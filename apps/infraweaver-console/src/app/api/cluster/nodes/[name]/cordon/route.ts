import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

async function handler(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:drain")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await params;
  const clusterId = getRequestClusterId(req);
  const body = await req.text();
  const res = await iwApiFetch(`/k8s/nodes/${encodeURIComponent(name)}/cordon`, session, clusterId, { method: "PATCH", body });
  return NextResponse.json(await res.json(), { status: res.status });
}

export const PATCH = handler;
export const POST = handler;
