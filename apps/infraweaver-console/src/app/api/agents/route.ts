import { NextRequest, NextResponse } from "next/server";
import { iwApiFetch } from "@/lib/iw-api";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getRequestClusterId } from "@/lib/cluster-context";
import { auth } from "@/lib/auth";
import { safeError } from "@/lib/utils";

// GET /api/agents — returns connected agents + pending discovery requests
export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:read"] });
  if (session instanceof NextResponse) return session;

  const clusterId = getRequestClusterId(request);

  try {
    const [agentsRes, pendingRes] = await Promise.all([
      iwApiFetch("/agents", session, clusterId),
      iwApiFetch("/agents/pending", session, clusterId),
    ]);

    const agents = agentsRes.ok ? await agentsRes.json() : { agents: [] };
    const pending = pendingRes.ok ? await pendingRes.json() : { pending: [] };

    return NextResponse.json({ ...agents, ...pending });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
