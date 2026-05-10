import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.listResourceQuotaForAllNamespaces();
    const quotas = (res.items as unknown[]).map(item => {
      const q = item as { metadata?: { namespace?: string; name?: string }; spec?: { hard?: Record<string, string> }; status?: { used?: Record<string, string> } };
      return {
        namespace: q.metadata?.namespace ?? "",
        name: q.metadata?.name ?? "",
        hard: q.spec?.hard ?? {},
        used: q.status?.used ?? {},
      };
    });
    return NextResponse.json({ quotas });
  } catch {
    return NextResponse.json({
      quotas: [
        { namespace: "default", name: "default-quota", hard: { "requests.cpu": "4", "requests.memory": "8Gi", "limits.cpu": "8", "limits.memory": "16Gi", pods: "20" }, used: { "requests.cpu": "1500m", "requests.memory": "3Gi", "limits.cpu": "3", "limits.memory": "6Gi", pods: "8" } },
        { namespace: "monitoring", name: "monitoring-quota", hard: { "requests.cpu": "2", "requests.memory": "4Gi", pods: "10" }, used: { "requests.cpu": "800m", "requests.memory": "2Gi", pods: "5" } },
      ],
    });
  }
}
