import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clusterId = getRequestClusterId(req);
  const res = await iwApiFetch("/cluster/rollout", session, clusterId, { method: "POST", body: "{}" });
  return NextResponse.json(await res.json(), { status: res.status });
}
