import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  ACTIVE_CLUSTER_COOKIE,
  getActiveClusterIdFromCookieValue,
  getClusterConfig,
  serializeActiveClusterCookie,
} from "@/lib/cluster-context";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    clusterId: getActiveClusterIdFromCookieValue(request.cookies.get(ACTIVE_CLUSTER_COOKIE)?.value),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json() as { clusterId?: string };
  const clusterId = body.clusterId?.trim();
  if (!clusterId || !getClusterConfig(clusterId)) {
    return NextResponse.json({ error: "Unknown cluster" }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: ACTIVE_CLUSTER_COOKIE,
    value: serializeActiveClusterCookie(clusterId),
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 60 * 60 * 24,
    path: "/",
  });

  return response;
}
