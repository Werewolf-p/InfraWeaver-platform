import { type NextRequest, NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute("cluster:read", async (req, session) => {
  const res = await iwApiFetch("/cluster/hpa", session, getRequestClusterId(req));
  return NextResponse.json(await res.json(), { status: res.status });
});

export const PATCH = withRoute("cluster:admin", async (req, session) => {
  const body = await req.text();
  const res = await iwApiFetch("/cluster/hpa", session, getRequestClusterId(req), { method: "PATCH", body });
  return NextResponse.json(await res.json(), { status: res.status });
});
