import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getClusterConfigs } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";

async function pingCluster(clusterId: string): Promise<"healthy" | "degraded" | "offline"> {
  try {
    const kc = loadKubeConfig(clusterId);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    await Promise.race([
      coreApi.listNamespace({ limit: 1 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    return "healthy";
  } catch {
    return "offline";
  }
}

export async function GET() {
  const session = await requireRoutePermissions({ all: ["cluster:read"] });
  if (session instanceof NextResponse) return session;

  const configs = getClusterConfigs();

  const results = await Promise.all(
    configs.map(async (cluster) => {
      const status = await pingCluster(cluster.id);
      const isLocal = cluster.isLocal ?? (cluster.id === "default" || !cluster.kubeconfig);
      return {
        id: cluster.id,
        name: cluster.displayName,
        description: cluster.description ?? (isLocal ? "Console host cluster" : "Remote cluster"),
        status,
        isLocal,
        tags: cluster.tags ?? [],
        lastSeen: new Date().toISOString(),
      };
    })
  );

  return NextResponse.json({ clusters: results });
}
