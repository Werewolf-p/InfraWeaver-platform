import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withRoute } from "@/lib/route-utils";

export const POST = withRoute("cluster:admin", async (req, session) => {
  const clusterId = getRequestClusterId(req);
  const body = await req.text();
  const res = await iwApiFetch("/exec", session, clusterId, { method: "POST", body });
  return NextResponse.json(await res.json(), { status: res.status });
});
