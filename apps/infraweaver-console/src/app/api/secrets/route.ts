import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clusterId = getRequestClusterId(request);
  const namespace = request.nextUrl.searchParams.get("namespace");
  const path = namespace ? `/secrets?namespace=${encodeURIComponent(namespace)}` : "/secrets";
  const res = await iwApiFetch(path, session, clusterId);
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clusterId = getRequestClusterId(request);
  const { namespace, name } = await request.json().catch(() => ({ namespace: "", name: "" }));
  if (!namespace || !name) return NextResponse.json({ error: "namespace and name are required" }, { status: 400 });
  const res = await iwApiFetch(`/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, session, clusterId, { method: "DELETE" });
  return NextResponse.json(await res.json(), { status: res.status });
}
