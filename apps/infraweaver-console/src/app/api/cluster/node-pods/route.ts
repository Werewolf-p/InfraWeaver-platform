import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

// GET /api/cluster/node-pods
// Returns all nodes with their running pods and resource usage.
// Used by the pod migration UI.

interface PodInfo {
  name: string;
  namespace: string;
  node: string;
  cpuMillicores: number;
  memoryMi: number;
  ownerKind: string | null;
  ownerName: string | null;
  status: string;
  canMigrate: boolean;
}

interface NodeInfo {
  name: string;
  allocatableMi: number;
  usedMi: number;
  availableMi: number;
  usedPct: number;
  status: "Ready" | "NotReady";
}

function kiToMi(kiStr: string): number {
  const ki = parseInt(kiStr.replace("Ki", "").replace("m", "")) || 0;
  return Math.round(ki / 1024);
}

function cpuToMillicores(cpuStr: string): number {
  if (!cpuStr) return 0;
  if (cpuStr.endsWith("m")) return parseInt(cpuStr) || 0;
  return Math.round((parseFloat(cpuStr) || 0) * 1000);
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "config:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const metricsApi = kc.makeApiClient(k8s.CustomObjectsApi);

  try {
    // ── Fetch nodes ───────────────────────────────────────────────────────────
    const nodesResp = await coreApi.listNode();
    const nodeItems = (nodesResp as { items?: unknown[] }).items ?? [];

    // ── Fetch node metrics ────────────────────────────────────────────────────
    const nodeMetricsMap: Record<string, { cpuM: number; memMi: number }> = {};
    try {
      const nm = await metricsApi.listClusterCustomObject({
        group: "metrics.k8s.io",
        version: "v1beta1",
        plural: "nodes",
      }) as { items?: Array<{ metadata?: { name?: string }; usage?: { cpu?: string; memory?: string } }> };
      for (const m of nm.items ?? []) {
        if (m.metadata?.name) {
          nodeMetricsMap[m.metadata.name] = {
            cpuM: cpuToMillicores(m.usage?.cpu ?? "0"),
            memMi: kiToMi(m.usage?.memory ?? "0Ki"),
          };
        }
      }
    } catch { /* metrics-server not available */ }

    // ── Fetch pod metrics ─────────────────────────────────────────────────────
    const podMetricsMap: Record<string, { cpuM: number; memMi: number }> = {};
    try {
      const pm = await metricsApi.listClusterCustomObject({
        group: "metrics.k8s.io",
        version: "v1beta1",
        plural: "pods",
      }) as { items?: Array<{ metadata?: { name?: string; namespace?: string }; containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }> };
      for (const p of pm.items ?? []) {
        const key = `${p.metadata?.namespace}/${p.metadata?.name}`;
        const cpuM = (p.containers ?? []).reduce((s, c) => s + cpuToMillicores(c.usage?.cpu ?? "0"), 0);
        const memMi = (p.containers ?? []).reduce((s, c) => s + kiToMi(c.usage?.memory ?? "0Ki"), 0);
        podMetricsMap[key] = { cpuM, memMi };
      }
    } catch { /* metrics not available */ }

    // ── Fetch all pods ────────────────────────────────────────────────────────
    const podsResp = await coreApi.listPodForAllNamespaces();
    const podItems = (podsResp as { items?: unknown[] }).items ?? [];

    // ── Build nodes list ──────────────────────────────────────────────────────
    const nodes: NodeInfo[] = nodeItems.map((n: unknown) => {
      const node = n as {
        metadata?: { name?: string };
        status?: {
          allocatable?: { memory?: string };
          conditions?: Array<{ type: string; status: string }>;
        };
      };
      const name = node.metadata?.name ?? "";
      const allocatableMi = kiToMi(node.status?.allocatable?.memory ?? "0Ki");
      const nm = nodeMetricsMap[name];
      const usedMi = nm?.memMi ?? 0;
      const ready = (node.status?.conditions ?? []).find(c => c.type === "Ready")?.status === "True";
      return {
        name,
        allocatableMi,
        usedMi,
        availableMi: allocatableMi - usedMi,
        usedPct: allocatableMi > 0 ? Math.round((usedMi / allocatableMi) * 100) : 0,
        status: ready ? "Ready" : "NotReady",
      };
    });

    // ── Build pods list ───────────────────────────────────────────────────────
    const pods: PodInfo[] = podItems
      .map((p: unknown) => {
        const pod = p as {
          metadata?: {
            name?: string;
            namespace?: string;
            ownerReferences?: Array<{ kind: string; name: string }>;
          };
          spec?: { nodeName?: string };
          status?: { phase?: string; conditions?: Array<{ type: string; status: string }> };
        };
        const name = pod.metadata?.name ?? "";
        const namespace = pod.metadata?.namespace ?? "";
        const node = pod.spec?.nodeName ?? "";
        const metricKey = `${namespace}/${name}`;
        const metrics = podMetricsMap[metricKey];
        const owner = pod.metadata?.ownerReferences?.[0];
        const phase = pod.status?.phase ?? "Unknown";
        const ready = (pod.status?.conditions ?? []).find(c => c.type === "Ready")?.status === "True";

        // Only Deployment-owned pods (via ReplicaSet) and StatefulSet pods can migrate
        const canMigrate = (
          phase === "Running" &&
          ready &&
          !!node &&
          !!owner &&
          (owner.kind === "ReplicaSet" || owner.kind === "StatefulSet") &&
          // Skip kube-system static pods (etcd, apiserver, etc.)
          !["kube-system", "longhorn-system"].includes(namespace)
        );

        return {
          name,
          namespace,
          node,
          cpuMillicores: metrics?.cpuM ?? 0,
          memoryMi: metrics?.memMi ?? 0,
          ownerKind: owner?.kind ?? null,
          ownerName: owner?.name ?? null,
          status: phase,
          canMigrate,
        };
      })
      .filter(p => p.node && p.status === "Running");

    return NextResponse.json({ nodes, pods });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch node pods";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
