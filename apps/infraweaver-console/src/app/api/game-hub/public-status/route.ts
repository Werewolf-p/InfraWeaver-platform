import { NextResponse } from "next/server";
import { GAME_HUB_NS, getServerPod, makeGameHubClients } from "@/lib/game-hub-server";

function serverStatus(deployment: { spec?: { replicas?: number }; status?: { readyReplicas?: number; replicas?: number } }) {
  if ((deployment.spec?.replicas ?? 0) === 0) return "stopped" as const;
  if ((deployment.status?.readyReplicas ?? 0) > 0) return "running" as const;
  if ((deployment.status?.replicas ?? 0) > 0) return "starting" as const;
  return "stopped" as const;
}

export async function GET() {
  try {
    const { appsApi, coreApi } = makeGameHubClients();
    const deployments = await appsApi.listNamespacedDeployment({
      namespace: GAME_HUB_NS,
      labelSelector: "infraweaver/game=true",
    });

    const servers = await Promise.all(
      (deployments.items ?? []).map(async (deployment) => {
        const name = deployment.metadata?.name ?? "unknown";
        const status = serverStatus(deployment);
        const pod = status === "stopped"
          ? null
          : await getServerPod(coreApi, name).catch(() => null);
        const startTime = pod?.status?.startTime
          ? new Date(pod.status.startTime as string | Date).toISOString()
          : null;
        return {
          name,
          status,
          uptimeSeconds: startTime
            ? Math.max(0, Math.floor((Date.now() - new Date(startTime).getTime()) / 1000))
            : null,
        };
      }),
    );

    const healthy = servers.filter((server) => server.status !== "starting").length;
    const degraded = servers.length - healthy;

    return NextResponse.json({
      overall: {
        total: servers.length,
        healthy,
        degraded,
      },
      servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("public status route failed", error);
    return NextResponse.json({ error: "Status unavailable" }, { status: 503 });
  }
}
