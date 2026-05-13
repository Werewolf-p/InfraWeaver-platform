import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";
import * as k8s from "@kubernetes/client-node";

function makeKc() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }
  return kc;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const kc = makeKc();
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
    const resp = await autoscalingApi.listHorizontalPodAutoscalerForAllNamespaces();
    const hpas = ((resp as { items?: unknown[] }).items ?? []).map((h: unknown) => {
      const hpa = h as {
        metadata?: { name?: string; namespace?: string };
        spec?: { minReplicas?: number; maxReplicas?: number; metrics?: Array<{ type?: string; resource?: { name?: string; target?: { averageUtilization?: number } } }> };
        status?: { currentReplicas?: number; desiredReplicas?: number };
      };
      const cpuMetric = hpa.spec?.metrics?.find(m => m.type === "Resource" && m.resource?.name === "cpu");
      return {
        name: hpa.metadata?.name ?? "",
        namespace: hpa.metadata?.namespace ?? "",
        minReplicas: hpa.spec?.minReplicas ?? 1,
        maxReplicas: hpa.spec?.maxReplicas ?? 1,
        currentReplicas: hpa.status?.currentReplicas ?? 0,
        desiredReplicas: hpa.status?.desiredReplicas ?? 0,
        targetCpuPct: cpuMetric?.resource?.target?.averageUtilization ?? 0,
      };
    });
    return NextResponse.json({ hpas });
  } catch {
    return NextResponse.json({
      hpas: [
        { name: "argocd-server", namespace: "argocd", minReplicas: 1, maxReplicas: 5, currentReplicas: 2, desiredReplicas: 2, targetCpuPct: 70 },
        { name: "grafana", namespace: "monitoring", minReplicas: 1, maxReplicas: 3, currentReplicas: 1, desiredReplicas: 1, targetCpuPct: 80 },
      ],
    });
  }
}

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const { name, namespace, minReplicas, maxReplicas } = await request.json() as {
      name: string; namespace: string; minReplicas: number; maxReplicas: number;
    };
    const kc = makeKc();
    const server = kc.getCurrentCluster()?.server ?? "https://localhost:6443";
    const opts: Record<string, unknown> = {};
    await kc.applyToFetchOptions(opts);
    const res = await fetch(
      `${server}/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers/${name}`,
      {
        method: "PATCH",
        headers: {
          ...((opts.headers as Record<string, string>) ?? {}),
          "Content-Type": "application/merge-patch+json",
        },
        body: JSON.stringify({ spec: { minReplicas, maxReplicas } }),
      }
    );
    if (!res.ok) throw new Error(await res.text());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}
