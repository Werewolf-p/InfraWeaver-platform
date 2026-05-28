import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { iwApiFetch } from "@/lib/iw-api";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getRequestClusterId } from "@/lib/cluster-context";
import { safeError } from "@/lib/utils";

const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const { agentId } = await params;
  const clusterId = getRequestClusterId(request);

  const rawBody = await request.json().catch(() => ({}));
  const parsed = rejectSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const res = await iwApiFetch(`/agents/pending/${encodeURIComponent(agentId)}/reject`, session, clusterId, {
      method: "POST",
      body: JSON.stringify({ reason: parsed.data.reason ?? "Rejected by admin" }),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
