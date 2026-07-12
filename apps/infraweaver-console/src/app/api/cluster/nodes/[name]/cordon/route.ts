import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";

const handler = withAuth<{ name: string }>({ permission: "cluster:drain" }, async ({ req, session, params }) => {
  const { name } = params;
  const clusterId = getRequestClusterId(req);
  const body = await req.text();
  const res = await iwApiFetch(`/k8s/nodes/${encodeURIComponent(name)}/cordon`, session, clusterId, { method: "PATCH", body });
  return NextResponse.json(await res.json(), { status: res.status });
});

export const PATCH = handler;
export const POST = handler;
