import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { validateK8sName } from "@/lib/api-security";
import { safeError } from "@/lib/utils";

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    // Prefer running pods; exclude Terminating (deletionTimestamp set)
    const active = (pods.items ?? []).filter((p) => !p.metadata?.deletionTimestamp);
    const pod = active.find((p) => p.status?.phase === "Running") ?? active[0];
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const activeInitContainer = (pod.status?.initContainerStatuses ?? []).find(
      (cs) => cs.state?.running != null && !cs.ready,
    );
    return NextResponse.json({
      podName: pod.metadata.name,
      namespace: GAME_HUB_NAMESPACE,
      containerName: pod.spec?.containers?.[0]?.name ?? name,
      logsUrl: `/api/logs/${GAME_HUB_NAMESPACE}/${pod.metadata.name}/${pod.spec?.containers?.[0]?.name ?? name}`,
      initContainerRunning: activeInitContainer != null,
      activeInitContainerName: activeInitContainer?.name ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
