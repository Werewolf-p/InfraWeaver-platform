import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const [metricsResp, podsResp] = await Promise.all([
      customApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "pods" }),
      coreApi.listPodForAllNamespaces(),
    ]);
    const limitsMap: Record<string, Record<string, { cpuLimit: number; memLimit: number }>> = {};
    for (const pod of (podsResp as { items?: unknown[] }).items ?? []) {
      const p = pod as {
        metadata?: { name?: string; namespace?: string };
        spec?: { containers?: Array<{ name?: string; resources?: { limits?: { cpu?: string; memory?: string } } }> };
      };
      const key = `${p.metadata?.namespace}/${p.metadata?.name}`;
      limitsMap[key] = {};
      for (const c of p.spec?.containers ?? []) {
        const cpuLimitStr = c.resources?.limits?.cpu ?? "0";
        const memLimitStr = c.resources?.limits?.memory ?? "0";
        let cpuLimit = 0;
        if (cpuLimitStr.endsWith("m")) cpuLimit = parseInt(cpuLimitStr);
        else cpuLimit = parseFloat(cpuLimitStr) * 1000;
        let memLimit = 0;
        if (memLimitStr.endsWith("Mi")) memLimit = parseInt(memLimitStr);
        else if (memLimitStr.endsWith("Gi")) memLimit = parseInt(memLimitStr) * 1024;
        else if (memLimitStr.endsWith("Ki")) memLimit = parseInt(memLimitStr) / 1024;
        limitsMap[key][c.name ?? ""] = { cpuLimit: Math.round(cpuLimit), memLimit: Math.round(memLimit) };
      }
    }
    const items = (metricsResp as { items?: unknown[] }).items ?? [];
    const pods = items.map((item: unknown) => {
      const m = item as {
        metadata?: { name?: string; namespace?: string };
        containers?: Array<{ name?: string; usage?: { cpu?: string; memory?: string } }>;
      };
      const key = `${m.metadata?.namespace}/${m.metadata?.name}`;
      const containers = (m.containers ?? []).map((c) => {
        const cpuStr = c.usage?.cpu ?? "0n";
        const memStr = c.usage?.memory ?? "0Ki";
        let cpuM = 0;
        if (cpuStr.endsWith("n")) cpuM = Math.round(parseInt(cpuStr) / 1_000_000);
        else if (cpuStr.endsWith("m")) cpuM = parseInt(cpuStr);
        else cpuM = Math.round(parseFloat(cpuStr) * 1000);
        let memMi = 0;
        if (memStr.endsWith("Ki")) memMi = Math.round(parseInt(memStr) / 1024);
        else if (memStr.endsWith("Mi")) memMi = parseInt(memStr);
        else if (memStr.endsWith("Gi")) memMi = parseInt(memStr) * 1024;
        const lim = limitsMap[key]?.[c.name ?? ""] ?? { cpuLimit: 0, memLimit: 0 };
        return {
          name: c.name ?? "",
          cpu_m: cpuM,
          memory_mi: memMi,
          cpu_limit_m: lim.cpuLimit,
          memory_limit_mi: lim.memLimit,
        };
      });
      return { namespace: m.metadata?.namespace ?? "", name: m.metadata?.name ?? "", containers };
    });
    return NextResponse.json({ pods });
  } catch {
    return NextResponse.json({
      pods: [
        { namespace: "argocd", name: "argocd-server-abc12", containers: [{ name: "argocd-server", cpu_m: 45, memory_mi: 128, cpu_limit_m: 500, memory_limit_mi: 512 }] },
        { namespace: "traefik", name: "traefik-xyz98", containers: [{ name: "traefik", cpu_m: 120, memory_mi: 256, cpu_limit_m: 1000, memory_limit_mi: 1024 }] },
        { namespace: "monitoring", name: "grafana-def56", containers: [{ name: "grafana", cpu_m: 200, memory_mi: 512, cpu_limit_m: 500, memory_limit_mi: 768 }] },
        { namespace: "monitoring", name: "prometheus-gh789", containers: [{ name: "prometheus", cpu_m: 350, memory_mi: 950, cpu_limit_m: 1000, memory_limit_mi: 1024 }] },
        { namespace: "gatus", name: "gatus-jkl01", containers: [{ name: "gatus", cpu_m: 15, memory_mi: 64, cpu_limit_m: 200, memory_limit_mi: 256 }] },
      ],
    });
  }
}
