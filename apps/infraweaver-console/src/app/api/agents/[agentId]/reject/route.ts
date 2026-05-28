import { NextRequest, NextResponse } from "next/server";
import { iwApiFetch } from "@/lib/iw-api";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getRequestClusterId } from "@/lib/cluster-context";
import { safeError } from "@/lib/utils";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const { agentId } = await params;
  const clusterId = getRequestClusterId(request);

  const rawBody = await request.json().catch(() => ({})) as { reason?: string };

  try {
    const res = await iwApiFetch(`/agents/pending/${encodeURIComponent(agentId)}/reject`, session, clusterId, {
      method: "POST",
      body: JSON.stringify({ reason: rawBody.reason ?? "Rejected by admin" }),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
