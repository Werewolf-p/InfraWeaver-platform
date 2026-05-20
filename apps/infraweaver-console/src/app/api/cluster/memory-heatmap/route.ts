import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const res = await iwApiFetch("/cluster/memory-heatmap", session, "local");
  return NextResponse.json(await res.json(), { status: res.status });
}
