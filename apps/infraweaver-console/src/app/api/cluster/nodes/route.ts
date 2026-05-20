import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clusterId = getRequestClusterId(request);
  const res = await iwApiFetch("/k8s/nodes", session, clusterId);
  return NextResponse.json(await res.json(), { status: res.status });
}
