import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ACTIVE_CLUSTER_COOKIE,
  getActiveClusterIdFromCookieValue,
  getClusterConfig,
  serializeActiveClusterCookie,
} from "@/lib/cluster-context";
import { parseBody, withRoute } from "@/lib/route-utils";

const postBodySchema = z.object({
  clusterId: z.string().min(1),
});

export const GET = withRoute(null, async (request: NextRequest) => {
  return NextResponse.json({
    clusterId: getActiveClusterIdFromCookieValue(request.cookies.get(ACTIVE_CLUSTER_COOKIE)?.value),
  });
});

export const POST = withRoute(null, async (request: NextRequest) => {
  const parsed = await parseBody(request, postBodySchema);
  if (parsed instanceof NextResponse) return parsed;
  const clusterId = parsed.clusterId;
  if (!getClusterConfig(clusterId)) {
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
});
