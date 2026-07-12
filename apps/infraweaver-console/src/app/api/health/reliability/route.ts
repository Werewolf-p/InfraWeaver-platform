import { NextResponse } from "next/server";
import { getArgocdAppsCached, summarizeArgoAppHealth } from "@/lib/argocd-apps";
import { calcUptime, fetchGatusStatuses } from "@/lib/gatus";
import { listItems, makeCoreApi } from "@/lib/kube-client";
import { listLonghornVolumes, loadBackupVolumeStatuses } from "@/lib/longhorn";
import {
  combineReliabilityComponents,
  scoreArgocdHealth,
  scoreBackupHealth,
  scoreNodeHealth,
  scoreStorageHealth,
  scoreUptime,
  summarizeBackupVolumes,
} from "@/lib/reliability";
import { unavailableResponse } from "@/lib/route-utils";
import { withAuth } from "@/lib/with-auth";

async function loadArgocdHealth() {
  const { apps, dataSource } = await getArgocdAppsCached();
  if (dataSource === "unavailable") throw new Error("ArgoCD applications unavailable");
  return summarizeArgoAppHealth(apps);
}

async function loadOverallUptime() {
  const endpoints = await fetchGatusStatuses();
  if (!endpoints.length) return 100;
  return endpoints.reduce((sum, endpoint) => sum + calcUptime(endpoint.results, 24), 0) / endpoints.length;
}

async function loadNodeHealth() {
  const response = await makeCoreApi().listNode();
  const items = listItems<{ status?: { conditions?: Array<{ type?: string; status?: string }> } }>(response);
  const ready = items.filter((node) => node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")).length;
  return { ready, total: items.length };
}

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    const [argocd, uptime24h, nodes, volumes, backupVolumes] = await Promise.all([
      loadArgocdHealth(),
      loadOverallUptime(),
      loadNodeHealth(),
      listLonghornVolumes(),
      loadBackupVolumeStatuses(),
    ]);

    const components = {
      nodes: scoreNodeHealth(nodes.ready, nodes.total),
      argocd: scoreArgocdHealth(argocd),
      uptime: scoreUptime(uptime24h),
      storage: scoreStorageHealth(volumes),
      backups: scoreBackupHealth(summarizeBackupVolumes(backupVolumes)),
    };

    const combined = combineReliabilityComponents(Object.values(components));

    return NextResponse.json({
      score: combined.score,
      grade: combined.grade,
      status: combined.status,
      components,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // FAIL CLOSED: no fabricated component scores when telemetry is down.
    return unavailableResponse(error);
  }
});
