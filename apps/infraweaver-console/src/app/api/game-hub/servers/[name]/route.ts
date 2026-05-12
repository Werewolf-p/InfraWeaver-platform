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

    // Resolve the node IP for the running pod (or first ready node as fallback)
    let nodeIp: string | null = process.env.GAME_HUB_EXTERNAL_HOSTNAME ?? null;
    if (!nodeIp) {
      try {
        const nodeName = pod?.spec?.nodeName;
        if (nodeName) {
          const node = await coreApi.readNode({ name: nodeName });
          nodeIp = node.status?.addresses?.find(a => a.type === "InternalIP")?.address ?? null;
        }
        if (!nodeIp) {
          const nodes = await coreApi.listNode();
          const ready = nodes.items.find(n =>
            n.status?.conditions?.some(c => c.type === "Ready" && c.status === "True")
          );
          nodeIp = ready?.status?.addresses?.find(a => a.type === "InternalIP")?.address ?? null;
        }
      } catch {}
    }

    // All service ports (Valheim has 3, Minecraft has 1, etc.)
    const allPorts = (svc?.spec?.ports ?? []).map(p => ({
      name: p.name ?? null,
      port: p.port,
      nodePort: p.nodePort ?? null,
      protocol: p.protocol ?? "TCP",
    }));

    return NextResponse.json({
      name,
      gameType: deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown",
      replicas: deployment.status?.replicas ?? 0,
      readyReplicas: deployment.status?.readyReplicas ?? 0,
      podName: pod?.metadata?.name ?? null,
      podPhase: pod?.status?.phase ?? null,
      podStartTime: pod?.status?.startTime ? new Date(pod.status.startTime as string | Date).toISOString() : null,
      port: svc?.spec?.ports?.[0]?.port ?? null,
      nodePort: svc?.spec?.ports?.[0]?.nodePort ?? null,
      nodeIp,
      allPorts,
      memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? "",
      cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? "",
      env: (deployment.spec?.template?.spec?.containers?.[0]?.env ?? []).map(e => ({
        name: e.name,
        value: e.value ?? undefined,
      })),
      createdAt: deployment.metadata?.creationTimestamp ? new Date(deployment.metadata.creationTimestamp as string | Date).toISOString() : null,
    });
  } catch (err) {
    console.error(`[game-hub] GET /servers/${(await params).name} failed:`, err);
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

    // Delete all PVCs for this server — query by label instead of guessing names
    try {
      const pvcs = await coreApi.listNamespacedPersistentVolumeClaim({
        namespace: GAME_HUB_NS,
        labelSelector: `app=${name}`,
      });
      await Promise.all(
        pvcs.items.map(pvc =>
          coreApi.deleteNamespacedPersistentVolumeClaim({
            name: pvc.metadata!.name!,
            namespace: GAME_HUB_NS,
          }).catch(() => {})
        )
      );
    } catch {
      // Also try common PVC names as fallback
      await coreApi.deleteNamespacedPersistentVolumeClaim({ name: `${name}-data`, namespace: GAME_HUB_NS }).catch(() => {});
      await coreApi.deleteNamespacedPersistentVolumeClaim({ name: `${name}-config`, namespace: GAME_HUB_NS }).catch(() => {});
    }

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
    } else if (body.action === "update-env") {
      const envBody = body as { action: string; env: Record<string, string> };
      const envVars = Object.entries(envBody.env ?? {}).map(([k, v]) => ({ name: k, value: v }));
      await appsApi.patchNamespacedDeployment({
        name, namespace: GAME_HUB_NS,
        body: {
          spec: {
            template: {
              spec: {
                containers: [{ name: (await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS })).spec?.template?.spec?.containers?.[0]?.name ?? name, env: envVars }],
              },
            },
          },
        },
        force: true,
        fieldManager: "infraweaver",
      });
    }

    return NextResponse.json({ action: body.action, name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
