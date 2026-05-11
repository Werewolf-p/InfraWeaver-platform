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

    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
    const pod = pods.items?.[0];

    if (!pod?.metadata?.name) {
      return NextResponse.json({ error: "No pod found" }, { status: 404 });
    }

    return NextResponse.json({
      podName: pod.metadata.name,
      namespace: GAME_HUB_NS,
      containerName: pod.spec?.containers?.[0]?.name ?? name,
      logsUrl: `/api/logs/${GAME_HUB_NS}/${pod.metadata.name}/${pod.spec?.containers?.[0]?.name ?? name}`,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
