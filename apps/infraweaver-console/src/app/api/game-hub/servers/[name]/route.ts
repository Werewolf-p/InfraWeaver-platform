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
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
    const pod = pods.items?.[0];

    let svc = null;
    try {
      svc = await coreApi.readNamespacedService({ name, namespace: GAME_HUB_NS });
    } catch {}

    return NextResponse.json({
      name,
      gameType: deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown",
      replicas: deployment.status?.replicas ?? 0,
      readyReplicas: deployment.status?.readyReplicas ?? 0,
      podName: pod?.metadata?.name ?? null,
      podPhase: pod?.status?.phase ?? null,
      podStartTime: pod?.status?.startTime ?? null,
      port: svc?.spec?.ports?.[0]?.port ?? null,
      nodePort: svc?.spec?.ports?.[0]?.nodePort ?? null,
      memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? "",
      cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? "",
      env: deployment.spec?.template?.spec?.containers?.[0]?.env ?? [],
      createdAt: deployment.metadata?.creationTimestamp ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    await appsApi.deleteNamespacedDeployment({ name, namespace: GAME_HUB_NS }).catch(() => {});
    await coreApi.deleteNamespacedService({ name, namespace: GAME_HUB_NS }).catch(() => {});
    await coreApi.deleteNamespacedPersistentVolumeClaim({ name: `${name}-data`, namespace: GAME_HUB_NS }).catch(() => {});

    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const body = await req.json() as { action: "start" | "stop" | "restart" };

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    if (body.action === "start") {
      await appsApi.patchNamespacedDeployment({
        name, namespace: GAME_HUB_NS,
        body: { spec: { replicas: 1 } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "stop") {
      await appsApi.patchNamespacedDeployment({
        name, namespace: GAME_HUB_NS,
        body: { spec: { replicas: 0 } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "restart") {
      const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
      for (const pod of pods.items ?? []) {
        await coreApi.deleteNamespacedPod({ name: pod.metadata?.name ?? "", namespace: GAME_HUB_NS }).catch(() => {});
      }
    }

    return NextResponse.json({ action: body.action, name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
