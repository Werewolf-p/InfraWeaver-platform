import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import { withGameHubAuth } from "@/lib/game-hub-server";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ req, name }) => {
  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);

    let deployEvents: Awaited<ReturnType<typeof coreApi.listNamespacedEvent>>["items"] = [];
    let podEvents: Awaited<ReturnType<typeof coreApi.listNamespacedEvent>>["items"] = [];
    try {
      deployEvents = (await coreApi.listNamespacedEvent({ namespace: GAME_HUB_NAMESPACE, fieldSelector: `involvedObject.name=${name},involvedObject.kind=Deployment` })).items ?? [];
    } catch {}
    try {
      podEvents = (await coreApi.listNamespacedEvent({ namespace: GAME_HUB_NAMESPACE, fieldSelector: "involvedObject.kind=Pod" })).items ?? [];
    } catch {}

    const eventTime = (value: string | Date | null | undefined) => value ? new Date(value).getTime() : 0;
    const events = [...deployEvents, ...podEvents.filter((event) => (event.involvedObject?.name ?? "").startsWith(`${name}-`))]
      .sort((left, right) => eventTime(right.lastTimestamp ?? right.firstTimestamp ?? null) - eventTime(left.lastTimestamp ?? left.firstTimestamp ?? null))
      .slice(0, 50)
      .map((event) => ({
        type: event.type ?? "Normal",
        reason: event.reason ?? "",
        message: event.message ?? "",
        timestamp: (event.lastTimestamp ?? event.firstTimestamp ?? null) as string | null,
        count: event.count ?? 1,
        involvedKind: event.involvedObject?.kind ?? "",
        involvedName: event.involvedObject?.name ?? "",
      }));

    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
