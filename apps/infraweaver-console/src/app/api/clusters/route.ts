import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";

const INFRAWEAVER_API_URL = process.env.INFRAWEAVER_API_URL
  ?? "http://infraweaver-api.infraweaver-console.svc.cluster.local:3001";

export interface ClusterInfo {
  id: string;
  name: string;
  description: string;
  status: "healthy" | "degraded" | "offline" | "unknown";
  isLocal: boolean;
  tags: string[];
  lastSeen: string;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["infra:read", "cluster:read", "config:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Always include the local cluster
  const local: ClusterInfo = {
    id: "local",
    name: "Local",
    description: "The cluster this console is running in",
    status: "healthy",
    isLocal: true,
    tags: ["local"],
    lastSeen: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${INFRAWEAVER_API_URL}/api/v1/clusters`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });

    if (!res.ok) return NextResponse.json({ clusters: [local] });

    const data = (await res.json()) as { items?: ClusterInfo[] };
    const remote: ClusterInfo[] = (data.items ?? []).filter((c) => !c.isLocal);
    return NextResponse.json({ clusters: [local, ...remote] });
  } catch {
    return NextResponse.json({ clusters: [local] });
  }
}
