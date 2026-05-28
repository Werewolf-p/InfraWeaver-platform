import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { iwApiFetch } from "@/lib/iw-api";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getRequestClusterId } from "@/lib/cluster-context";
import { safeError } from "@/lib/utils";

const approveSchema = z.object({
  clusterId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  clusterName: z.string().min(1).max(128).optional(),
  environment: z.enum(["production", "staging", "development"]).default("production"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const { agentId } = await params;
  const clusterId = getRequestClusterId(request);

  const rawBody = await request.json().catch(() => ({}));
  const parsed = approveSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const res = await iwApiFetch(`/agents/pending/${encodeURIComponent(agentId)}/approve`, session, clusterId, {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
