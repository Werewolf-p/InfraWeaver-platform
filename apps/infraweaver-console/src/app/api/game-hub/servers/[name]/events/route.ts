import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const GAME_HUB_NS = "game-hub";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    let deployEvents: Awaited<ReturnType<typeof coreApi.listNamespacedEvent>>["items"] = [];
    let podEvents: Awaited<ReturnType<typeof coreApi.listNamespacedEvent>>["items"] = [];

    try {
      deployEvents = (await coreApi.listNamespacedEvent({
        namespace: GAME_HUB_NS,
        fieldSelector: `involvedObject.name=${name},involvedObject.kind=Deployment`,
      })).items ?? [];
    } catch {}

    try {
      podEvents = (await coreApi.listNamespacedEvent({
        namespace: GAME_HUB_NS,
        fieldSelector: "involvedObject.kind=Pod",
      })).items ?? [];
    } catch {}

    const eventTime = (value: string | Date | null | undefined) => value ? new Date(value).getTime() : 0;

    const events = [
      ...deployEvents,
      ...podEvents.filter((e) => (e.involvedObject?.name ?? "").startsWith(`${name}-`)),
    ]
      .sort((a, b) => eventTime(b.lastTimestamp ?? b.firstTimestamp ?? null) - eventTime(a.lastTimestamp ?? a.firstTimestamp ?? null))
      .slice(0, 50)
      .map((e) => ({
        type: e.type ?? "Normal",
        reason: e.reason ?? "",
        message: e.message ?? "",
        timestamp: (e.lastTimestamp ?? e.firstTimestamp ?? null) as string | null,
        count: e.count ?? 1,
        involvedKind: e.involvedObject?.kind ?? "",
        involvedName: e.involvedObject?.name ?? "",
      }));

    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
