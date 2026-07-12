import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";

export const POST = withAuth({ permission: "cluster:admin" }, async ({ req, session }) => {
  const clusterId = getRequestClusterId(req);
  const res = await iwApiFetch("/cluster/rollout", session, clusterId, { method: "POST", body: "{}" });
  return NextResponse.json(await res.json(), { status: res.status });
});
