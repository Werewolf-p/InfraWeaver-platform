import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clusterId = getRequestClusterId(request);
  const namespace = request.nextUrl.searchParams.get("namespace");
  const path = namespace ? `/config-maps?namespace=${encodeURIComponent(namespace)}` : "/config-maps";
  const res = await iwApiFetch(path, session, clusterId);
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clusterId = getRequestClusterId(request);
  const body = await request.json();
  const { namespace, name, data } = body;
  if (!namespace || !name) return NextResponse.json({ error: "namespace and name are required" }, { status: 400 });
  const res = await iwApiFetch(`/config-maps/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, session, clusterId, { method: "PATCH", body: JSON.stringify({ data }) });
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clusterId = getRequestClusterId(request);
  const { namespace, name } = await request.json().catch(() => ({ namespace: "", name: "" }));
  if (!namespace || !name) return NextResponse.json({ error: "namespace and name are required" }, { status: 400 });
  const res = await iwApiFetch(`/config-maps/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, session, clusterId, { method: "DELETE" });
  return NextResponse.json(await res.json(), { status: res.status });
}
