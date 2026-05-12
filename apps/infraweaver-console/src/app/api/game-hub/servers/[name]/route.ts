import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildEggConfigMap, getEggEnvironmentDefaults, getEggForGameType, getEggPorts, type GameEgg } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission, parseEggConfig } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

function getDeploymentGameType(deployment: { metadata?: { labels?: Record<string, string> } } | null | undefined) {
  return deployment?.metadata?.labels?.["infraweaver/game-type"] ?? deployment?.metadata?.labels?.["infraweaver.io/game-type"] ?? "unknown";
}

async function readServerEgg(coreApi: import("@kubernetes/client-node").CoreV1Api, name: string, deployment?: { metadata?: { labels?: Record<string, string> } }) {
  try {
    const configMap = await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE });
    return parseEggConfig(configMap.data?.["egg.json"], getDeploymentGameType(deployment));
  } catch {
    return getEggForGameType(getDeploymentGameType(deployment));
  }
}

async function upsertEggConfigMap(
  coreApi: import("@kubernetes/client-node").CoreV1Api,
  serverName: string,
  egg: GameEgg,
  env: Record<string, string>,
) {
  const body = buildEggConfigMap(GAME_HUB_NAMESPACE, serverName, egg, env);
  try {
    await coreApi.readNamespacedConfigMap({ name: `gameserver-${serverName}-egg`, namespace: GAME_HUB_NAMESPACE });
    await coreApi.replaceNamespacedConfigMap({ name: `gameserver-${serverName}-egg`, namespace: GAME_HUB_NAMESPACE, body });
  } catch {
    await coreApi.createNamespacedConfigMap({ namespace: GAME_HUB_NAMESPACE, body });
  }
}

function actionPermission(action: string) {
  if (action === "start") return "game-hub:start" as const;
  if (action === "stop") return "game-hub:stop" as const;
  if (action === "scale") return "game-hub:scale" as const;
  if (["set-hpa", "remove-hpa", "update-env", "set-restart-policy", "set-notes", "update-resources"].includes(action)) {
    return "game-hub:admin" as const;
  }
  return "game-hub:write" as const;
}

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
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);

    const deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
    const egg = await readServerEgg(coreApi, name, deployment);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    const pod = pods.items?.[0];

    let service = null;
    try {
      service = await coreApi.readNamespacedService({ name, namespace: GAME_HUB_NAMESPACE });
    } catch {}

    let nodeIp: string | null = process.env.GAME_HUB_EXTERNAL_HOSTNAME ?? null;
    if (!nodeIp) {
      try {
        const nodeName = pod?.spec?.nodeName;
        if (nodeName) {
          const node = await coreApi.readNode({ name: nodeName });
          nodeIp = node.status?.addresses?.find((entry) => entry.type === "InternalIP")?.address ?? null;
        }
        if (!nodeIp) {
          const nodes = await coreApi.listNode();
          const ready = nodes.items.find((node) => node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"));
          nodeIp = ready?.status?.addresses?.find((entry) => entry.type === "InternalIP")?.address ?? null;
        }
      } catch {}
    }

    let hpa: { enabled: boolean; min: number; max: number; cpuTarget: number | null; currentReplicas: number | null } = {
      enabled: false,
      min: 1,
      max: 3,
      cpuTarget: 70,
      currentReplicas: null,
    };
    try {
      const hpaObj = await autoscalingApi.readNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE });
      const cpuMetric = hpaObj.spec?.metrics?.find((metric) => metric.type === "Resource" && metric.resource?.name === "cpu");
      hpa = {
        enabled: true,
        min: hpaObj.spec?.minReplicas ?? 1,
        max: hpaObj.spec?.maxReplicas ?? 3,
        cpuTarget: cpuMetric?.resource?.target?.averageUtilization ?? null,
        currentReplicas: hpaObj.status?.currentReplicas ?? null,
      };
    } catch {}

    return NextResponse.json({
      name,
      gameType: getDeploymentGameType(deployment),
      egg,
      replicas: deployment.status?.replicas ?? 0,
      readyReplicas: deployment.status?.readyReplicas ?? 0,
      podName: pod?.metadata?.name ?? null,
      podPhase: pod?.status?.phase ?? null,
      podStartTime: pod?.status?.startTime ? new Date(pod.status.startTime as string | Date).toISOString() : null,
      port: service?.spec?.ports?.[0]?.port ?? null,
      nodePort: service?.spec?.ports?.[0]?.nodePort ?? null,
      nodeIp,
      allPorts: (service?.spec?.ports ?? []).map((port) => ({
        name: port.name ?? null,
        port: port.port,
        nodePort: port.nodePort ?? null,
        protocol: port.protocol ?? "TCP",
      })),
      hpa,
      restartPolicy: deployment.spec?.template?.spec?.restartPolicy ?? "Always",
      memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? egg.defaultMemory ?? "",
      cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? egg.defaultCpu ?? "",
      notes: deployment.metadata?.annotations?.["infraweaver/notes"] ?? "",
      env: (deployment.spec?.template?.spec?.containers?.[0]?.env ?? []).map((entry) => ({ name: entry.name, value: entry.value ?? undefined })),
      createdAt: deployment.metadata?.creationTimestamp ? new Date(deployment.metadata.creationTimestamp as string | Date).toISOString() : null,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    await appsApi.deleteNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => {});
    await coreApi.deleteNamespacedService({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => {});
    await coreApi.deleteNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE }).catch(() => {});

    try {
      const pvcs = await coreApi.listNamespacedPersistentVolumeClaim({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
      await Promise.all(pvcs.items.map((pvc) =>
        coreApi.deleteNamespacedPersistentVolumeClaim({ name: pvc.metadata?.name ?? "", namespace: GAME_HUB_NAMESPACE }).catch(() => {})
      ));
    } catch {
      await coreApi.deleteNamespacedPersistentVolumeClaim({ name: `${name}-data`, namespace: GAME_HUB_NAMESPACE }).catch(() => {});
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const body = await req.json() as {
    action: "start" | "stop" | "restart" | "scale" | "set-hpa" | "remove-hpa" | "update-env" | "set-restart-policy" | "set-notes" | "update-resources";
    replicas?: number;
    hpaMin?: number;
    hpaMax?: number;
    hpaCpuTarget?: number;
    env?: Record<string, string>;
    restartPolicy?: boolean;
    notes?: string;
    memory?: string;
    cpu?: string;
  };

  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, actionPermission(body.action), name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);

    if (body.action === "start") {
      await appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: 1 } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "stop") {
      await appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: 0 } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "restart") {
      const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
      for (const pod of pods.items ?? []) {
        await coreApi.deleteNamespacedPod({ name: pod.metadata?.name ?? "", namespace: GAME_HUB_NAMESPACE }).catch(() => {});
      }
    } else if (body.action === "scale") {
      await autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => {});
      const count = Math.max(0, Math.min(body.replicas ?? 1, 10));
      await appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: count } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "set-hpa") {
      const min = Math.max(1, body.hpaMin ?? 1);
      const max = Math.max(min, body.hpaMax ?? 3);
      const cpu = Math.min(100, Math.max(10, body.hpaCpuTarget ?? 70));
      const hpaSpec = {
        apiVersion: "autoscaling/v2",
        kind: "HorizontalPodAutoscaler",
        metadata: { name, namespace: GAME_HUB_NAMESPACE },
        spec: {
          scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name },
          minReplicas: min,
          maxReplicas: max,
          metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: cpu } } }],
        },
      };
      try {
        await autoscalingApi.patchNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE, body: hpaSpec, force: true, fieldManager: "infraweaver" });
      } catch {
        await autoscalingApi.createNamespacedHorizontalPodAutoscaler({ namespace: GAME_HUB_NAMESPACE, body: hpaSpec });
      }
    } else if (body.action === "remove-hpa") {
      await autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => {});
    } else if (body.action === "update-env") {
      const deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
      const egg = await readServerEgg(coreApi, name, deployment);
      const envVars = Object.entries(body.env ?? {}).map(([key, value]) => ({ name: key, value }));
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, env: envVars }] } } } },
        force: true,
        fieldManager: "infraweaver",
      });
      await upsertEggConfigMap(coreApi, name, egg, body.env ?? getEggEnvironmentDefaults(egg));
    } else if (body.action === "set-restart-policy") {
      const policy = body.restartPolicy === true ? "Always" : "OnFailure";
      await appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { template: { spec: { restartPolicy: policy } } } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "set-notes") {
      await appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { metadata: { annotations: { "infraweaver/notes": body.notes ?? "" } } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "update-resources") {
      const containerName = (await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE })).spec?.template?.spec?.containers?.[0]?.name ?? name;
      await appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, resources: { limits: { memory: body.memory, cpu: body.cpu }, requests: { memory: body.memory, cpu: body.cpu } } }] } } } },
        force: true,
        fieldManager: "infraweaver",
      });
    }

    return NextResponse.json({ action: body.action, name });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
