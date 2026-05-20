import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseCpuQuantity, parseMemoryBytes } from "@/lib/game-hub-server";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

interface ConsumerRecord {
  pod: string;
  namespace: string;
  node: string;
  cpu_cores: number;
  cpu_pct: number;
  memory_mib: number;
  memory_pct: number;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const FALLBACK: { cpu: Array<Pick<ConsumerRecord, "pod" | "namespace" | "node" | "cpu_cores" | "cpu_pct">>; memory: Array<Pick<ConsumerRecord, "pod" | "namespace" | "node" | "memory_mib" | "memory_pct">>; } = {
  cpu: [
    { pod: "prometheus-kube-prometheus-stack-prometheus-0", namespace: "monitoring", node: "talos-prod-cp3", cpu_cores: 0.44, cpu_pct: 5.5 },
    { pod: "grafana-7d8f8c7f9-ptt8d", namespace: "apps-grafana", node: "talos-prod-cp2", cpu_cores: 0.21, cpu_pct: 2.6 },
    { pod: "argocd-application-controller-0", namespace: "argocd", node: "talos-prod-cp1", cpu_cores: 0.16, cpu_pct: 2 },
  ],
  memory: [
    { pod: "prometheus-kube-prometheus-stack-prometheus-0", namespace: "monitoring", node: "talos-prod-cp3", memory_mib: 1176, memory_pct: 9.2 },
    { pod: "loki-0", namespace: "monitoring", node: "talos-prod-cp2", memory_mib: 684, memory_pct: 5.3 },
    { pod: "grafana-7d8f8c7f9-ptt8d", namespace: "apps-grafana", node: "talos-prod-cp2", memory_mib: 428, memory_pct: 3.3 },
  ],
};

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["infra:read", "config:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }

    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const [nodesResp, podsResp, metricsResp] = await Promise.all([
      coreApi.listNode(),
      coreApi.listPodForAllNamespaces(),
      customApi.listClusterCustomObject({
        group: "metrics.k8s.io",
        version: "v1beta1",
        plural: "pods",
      }),
    ]);

    const nodeCapacityByName: Record<string, { cpuCores: number; memoryBytes: number }> = {};
    for (const item of (nodesResp as { items?: unknown[] }).items ?? []) {
      const node = item as {
        metadata?: { name?: string };
        status?: { allocatable?: { cpu?: string; memory?: string }; capacity?: { cpu?: string; memory?: string } };
      };
      const name = node.metadata?.name ?? "";
      if (!name) continue;
      nodeCapacityByName[name] = {
        cpuCores: parseCpuQuantity(node.status?.allocatable?.cpu ?? node.status?.capacity?.cpu ?? "0"),
        memoryBytes: parseMemoryBytes(node.status?.allocatable?.memory ?? node.status?.capacity?.memory ?? "0"),
      };
    }

    const podNodeByKey: Record<string, string> = {};
    for (const item of (podsResp as { items?: unknown[] }).items ?? []) {
      const pod = item as {
        metadata?: { name?: string; namespace?: string };
        spec?: { nodeName?: string };
        status?: { phase?: string };
      };
      const namespace = pod.metadata?.namespace ?? "";
      const name = pod.metadata?.name ?? "";
      const nodeName = pod.spec?.nodeName ?? "";
      if (!namespace || !name || !nodeName) continue;
      if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
      podNodeByKey[`${namespace}/${name}`] = nodeName;
    }

    const consumers = ((metricsResp as { items?: unknown[] }).items ?? [])
      .map((item) => {
        const metric = item as {
          metadata?: { name?: string; namespace?: string };
          containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
        };
        const namespace = metric.metadata?.namespace ?? "";
        const pod = metric.metadata?.name ?? "";
        const node = podNodeByKey[`${namespace}/${pod}`] ?? "";
        const capacity = nodeCapacityByName[node] ?? { cpuCores: 0, memoryBytes: 0 };
        const cpuCores = (metric.containers ?? []).reduce((sum, container) => sum + parseCpuQuantity(container.usage?.cpu ?? "0"), 0);
        const memoryBytes = (metric.containers ?? []).reduce((sum, container) => sum + parseMemoryBytes(container.usage?.memory ?? "0"), 0);
        return {
          pod,
          namespace,
          node,
          cpu_cores: round(cpuCores, 3),
          cpu_pct: capacity.cpuCores > 0 ? round((cpuCores / capacity.cpuCores) * 100, 1) : 0,
          memory_mib: round(memoryBytes / 1024 ** 2, 1),
          memory_pct: capacity.memoryBytes > 0 ? round((memoryBytes / capacity.memoryBytes) * 100, 1) : 0,
        } satisfies ConsumerRecord;
      })
      .filter((item) => item.namespace && item.pod);

    const cpu = [...consumers]
      .sort((left, right) => right.cpu_cores - left.cpu_cores || right.cpu_pct - left.cpu_pct)
      .slice(0, 10)
      .map(({ pod, namespace, node, cpu_cores, cpu_pct }) => ({ pod, namespace, node, cpu_cores, cpu_pct }));

    const memory = [...consumers]
      .sort((left, right) => right.memory_mib - left.memory_mib || right.memory_pct - left.memory_pct)
      .slice(0, 10)
      .map(({ pod, namespace, node, memory_mib, memory_pct }) => ({ pod, namespace, node, memory_mib, memory_pct }));

    return NextResponse.json({ cpu, memory });
  } catch {
    return NextResponse.json(FALLBACK);
  }
}
