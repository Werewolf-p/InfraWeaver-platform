import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";

const MIGRATE_POD_SCHEMA = z.object({
  namespace: z.string().min(1).max(63),
  podName: z.string().min(1).max(253),
  targetNode: z.string().min(1).max(253),
});

function kiToMi(kiStr: string): number {
  return Math.round(parseInt(kiStr.replace("Ki", "")) / 1024);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden — requires cluster:admin" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("cluster-migrate-pod", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = MIGRATE_POD_SCHEMA.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { namespace, podName, targetNode } = parsed.data;
  if (!isValidNamespace(namespace) || !isValidK8sName(podName) || !isValidK8sName(targetNode)) {
    return NextResponse.json({ error: "Invalid pod or node name" }, { status: 400 });
  }

  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const metricsApi = kc.makeApiClient(k8s.CustomObjectsApi);

  try {
    const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
    const podSpec = (pod as { spec?: { nodeName?: string }; metadata?: { ownerReferences?: Array<{ kind: string; name: string }> } });
    const currentNode = podSpec.spec?.nodeName;
    if (currentNode === targetNode) {
      return NextResponse.json({ error: "Pod is already on that node" }, { status: 400 });
    }

    const owners = podSpec.metadata?.ownerReferences ?? [];
    const rsOwner = owners.find(o => o.kind === "ReplicaSet");
    const stsOwner = owners.find(o => o.kind === "StatefulSet");
    let deploymentName: string | null = null;
    let statefulSetName: string | null = null;

    if (rsOwner) {
      const rs = await appsApi.readNamespacedReplicaSet({ name: rsOwner.name, namespace });
      const rsOwners = (rs as { metadata?: { ownerReferences?: Array<{ kind: string; name: string }> } }).metadata?.ownerReferences ?? [];
      const depOwner = rsOwners.find(o => o.kind === "Deployment");
      if (depOwner) deploymentName = depOwner.name;
    } else if (stsOwner) {
      statefulSetName = stsOwner.name;
    }

    if (!deploymentName && !statefulSetName) {
      return NextResponse.json({ error: "Pod is not managed by a Deployment or StatefulSet — cannot migrate" }, { status: 400 });
    }

    let podMemoryMi = 256;
    try {
      const podMetrics = await metricsApi.listNamespacedCustomObject({
        group: "metrics.k8s.io",
        version: "v1beta1",
        namespace,
        plural: "pods",
      }) as { items?: Array<{ metadata?: { name?: string }; containers?: Array<{ usage?: { memory?: string } }> }> };
      const podMetric = (podMetrics.items ?? []).find(p => p.metadata?.name === podName);
      if (podMetric) {
        const totalMemKi = (podMetric.containers ?? []).reduce((sum, c) => {
          const mem = c.usage?.memory ?? "0Ki";
          return sum + (parseInt(mem.replace("Ki", "")) || 0);
        }, 0);
        podMemoryMi = Math.round(totalMemKi / 1024);
      }
    } catch {}

    const nodesResp = await coreApi.listNode();
    const nodes = (nodesResp as { items?: unknown[] }).items ?? [];
    const targetNodeObj = nodes.find((n: unknown) => {
      const node = n as { metadata?: { name?: string } };
      return node.metadata?.name === targetNode;
    }) as { status?: { allocatable?: { memory?: string }; conditions?: Array<{ type: string; status: string }> } } | undefined;

    if (!targetNodeObj) {
      return NextResponse.json({ error: `Target node ${targetNode} not found` }, { status: 400 });
    }
    const targetReady = (targetNodeObj.status?.conditions ?? []).find(c => c.type === "Ready")?.status === "True";
    if (!targetReady) {
      return NextResponse.json({ error: `Target node ${targetNode} is not Ready` }, { status: 400 });
    }

    const allocatableMi = kiToMi(targetNodeObj.status?.allocatable?.memory ?? "0Ki");

    let targetNodeUsedMi = 0;
    try {
      const nodeMetrics = await metricsApi.listClusterCustomObject({
        group: "metrics.k8s.io",
        version: "v1beta1",
        plural: "nodes",
      }) as { items?: Array<{ metadata?: { name?: string }; usage?: { memory?: string } }> };
      const nm = (nodeMetrics.items ?? []).find(m => m.metadata?.name === targetNode);
      if (nm) targetNodeUsedMi = kiToMi(nm.usage?.memory ?? "0Ki");
    } catch {}

    const availableAfterMove = allocatableMi - targetNodeUsedMi - podMemoryMi;
    const bufferMi = 512;
    if (availableAfterMove < bufferMi) {
      return NextResponse.json({
        error: `Not enough memory on ${targetNode}. Available: ${allocatableMi - targetNodeUsedMi} Mi, needed: ${podMemoryMi + bufferMi} Mi (pod ${podMemoryMi} Mi + ${bufferMi} Mi buffer)`,
        availableMi: allocatableMi - targetNodeUsedMi,
        neededMi: podMemoryMi + bufferMi,
      }, { status: 409 });
    }

    const affinityPatch = {
      spec: {
        template: {
          spec: {
            affinity: {
              nodeAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 100,
                    preference: {
                      matchExpressions: [
                        {
                          key: "kubernetes.io/hostname",
                          operator: "In",
                          values: [targetNode],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };

    if (deploymentName) {
      await appsApi.patchNamespacedDeployment({
        name: deploymentName,
        namespace,
        body: affinityPatch,
      });
    } else if (statefulSetName) {
      await appsApi.patchNamespacedStatefulSet({
        name: statefulSetName,
        namespace,
        body: affinityPatch,
      });
    }

    await coreApi.deleteNamespacedPod({ name: podName, namespace });

    return NextResponse.json({
      ok: true,
      movedFrom: currentNode,
      movedTo: targetNode,
      pod: podName,
      workload: deploymentName ?? statefulSetName,
      podMemoryMi,
      targetAvailableMi: allocatableMi - targetNodeUsedMi,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}
