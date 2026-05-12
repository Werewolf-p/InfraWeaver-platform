import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    const pod = pods.items?.[0];
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    return NextResponse.json({
      podName: pod.metadata.name,
      namespace: GAME_HUB_NAMESPACE,
      containerName: pod.spec?.containers?.[0]?.name ?? name,
      logsUrl: `/api/logs/${GAME_HUB_NAMESPACE}/${pod.metadata.name}/${pod.spec?.containers?.[0]?.name ?? name}`,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
