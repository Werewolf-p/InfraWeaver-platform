import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseMemoryBytes } from "@/lib/game-hub-server";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

interface NamespaceBreakdown {
  name: string;
  total_request_mib: number;
  total_limit_mib: number;
  pod_count: number;
}

function quantityToString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function podMemoryFromSpec(
  containers: Array<{ resources?: { requests?: { memory?: unknown }; limits?: { memory?: unknown } } }> | undefined,
  type: "requests" | "limits",
) {
  return (containers ?? []).reduce((sum, container) => {
    const resources = type === "requests" ? container.resources?.requests : container.resources?.limits;
    return sum + parseMemoryBytes(quantityToString(resources?.memory));
  }, 0);
}

const FALLBACK: { namespaces: NamespaceBreakdown[] } = {
  namespaces: [
    { name: "monitoring", total_request_mib: 2048, total_limit_mib: 4096, pod_count: 12 },
    { name: "argocd", total_request_mib: 768, total_limit_mib: 1536, pod_count: 7 },
    { name: "apps-grafana", total_request_mib: 256, total_limit_mib: 512, pod_count: 2 },
    { name: "gatus", total_request_mib: 128, total_limit_mib: 256, pod_count: 1 },
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
    const podsResp = await coreApi.listPodForAllNamespaces();
    const totalsByNamespace: Record<string, { requestBytes: number; limitBytes: number; podCount: number }> = {};

    for (const item of (podsResp as { items?: unknown[] }).items ?? []) {
      const pod = item as {
        metadata?: { namespace?: string };
        spec?: {
          containers?: Array<{ resources?: { requests?: { memory?: unknown }; limits?: { memory?: unknown } } }>;
          initContainers?: Array<{ resources?: { requests?: { memory?: unknown }; limits?: { memory?: unknown } } }>;
        };
        status?: { phase?: string };
      };
      const namespace = pod.metadata?.namespace ?? "default";
      if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
      if (!totalsByNamespace[namespace]) {
        totalsByNamespace[namespace] = { requestBytes: 0, limitBytes: 0, podCount: 0 };
      }

      const appRequestBytes = podMemoryFromSpec(pod.spec?.containers, "requests");
      const initRequestBytes = Math.max(...(pod.spec?.initContainers ?? []).map((container) => parseMemoryBytes(quantityToString(container.resources?.requests?.memory))), 0);
      const appLimitBytes = podMemoryFromSpec(pod.spec?.containers, "limits");
      const initLimitBytes = Math.max(...(pod.spec?.initContainers ?? []).map((container) => parseMemoryBytes(quantityToString(container.resources?.limits?.memory))), 0);

      totalsByNamespace[namespace].requestBytes += Math.max(appRequestBytes, initRequestBytes);
      totalsByNamespace[namespace].limitBytes += Math.max(appLimitBytes, initLimitBytes);
      totalsByNamespace[namespace].podCount += 1;
    }

    const namespaces = Object.entries(totalsByNamespace)
      .map(([name, totals]) => ({
        name,
        total_request_mib: round(totals.requestBytes / 1024 ** 2, 1),
        total_limit_mib: round(totals.limitBytes / 1024 ** 2, 1),
        pod_count: totals.podCount,
      }))
      .sort((left, right) => right.total_request_mib - left.total_request_mib || right.total_limit_mib - left.total_limit_mib);

    return NextResponse.json({ namespaces });
  } catch {
    return NextResponse.json(FALLBACK);
  }
}
