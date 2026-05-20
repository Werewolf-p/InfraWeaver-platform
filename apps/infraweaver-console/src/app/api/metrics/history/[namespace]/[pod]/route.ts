import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getRequestClusterId } from "@/lib/cluster-context";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/game-hub";
import { parseCpuQuantity, parseMemoryBytes } from "@/lib/game-hub-server";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";
const HISTORY_WINDOW_SECONDS = 3600;
const HISTORY_STEP_SECONDS = 30;

type MetricPoint = {
  cpu: number;
  cpuLimit: number;
  memory: number;
  memoryLimit: number;
  cpuRaw: number;
  memoryRaw: number;
  timestamp: string;
};

type PrometheusMatrixResponse = {
  status?: string;
  error?: string;
  errorType?: string;
  data?: {
    result?: Array<{
      values?: Array<[number | string, string]>;
    }>;
  };
};

async function queryPrometheusRange(query: string, start: number, end: number, step: number) {
  const params = new URLSearchParams({
    query,
    start: String(start),
    end: String(end),
    step: String(step),
  });
  const response = await fetch(`${PROMETHEUS_URL}/api/v1/query_range?${params.toString()}`, {
    cache: "no-store",
  });
  const body = await response.json() as PrometheusMatrixResponse;
  if (!response.ok || body.status !== "success") {
    throw new Error(body.error ?? body.errorType ?? `Prometheus query failed (${response.status})`);
  }
  return body.data?.result?.[0]?.values ?? [];
}

function valuesToMap(values: Array<[number | string, string]>) {
  return new Map(
    values.map(([timestamp, value]) => [Number(timestamp), Number.parseFloat(value ?? "0")]),
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; pod: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "apps:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { namespace, pod } = await params;
  if (!isValidNamespace(namespace) || !isValidK8sName(pod)) {
    return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
  }

  const gameHubAccess = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(gameHubAccess.groups, gameHubAccess.username, gameHubAccess.roleAssignments, namespace, pod)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    const podResource = await coreApi.readNamespacedPod({ name: pod, namespace });
    const containers = podResource.spec?.containers ?? [];
    const cpuLimit = containers.reduce(
      (sum, container) =>
        sum + parseCpuQuantity(typeof container.resources?.limits?.cpu === "string" ? container.resources.limits.cpu : null),
      0,
    );
    const memoryLimit = containers.reduce(
      (sum, container) =>
        sum + parseMemoryBytes(typeof container.resources?.limits?.memory === "string" ? container.resources.limits.memory : null),
      0,
    );

    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - HISTORY_WINDOW_SECONDS;
    const selector = `namespace="${namespace}",pod="${pod}",container!="",container!="POD"`;
    const cpuQuery = `sum(rate(container_cpu_usage_seconds_total{${selector}}[5m]))`;
    const memoryQuery = `sum(container_memory_working_set_bytes{${selector}})`;

    const [cpuValues, memoryValues] = await Promise.all([
      queryPrometheusRange(cpuQuery, startTime, endTime, HISTORY_STEP_SECONDS),
      queryPrometheusRange(memoryQuery, startTime, endTime, HISTORY_STEP_SECONDS),
    ]);

    const cpuByTimestamp = valuesToMap(cpuValues);
    const memoryByTimestamp = valuesToMap(memoryValues);
    const timestamps = [...new Set([...cpuByTimestamp.keys(), ...memoryByTimestamp.keys()])].sort((left, right) => left - right);
    const points: MetricPoint[] = timestamps.map((timestamp) => {
      const cpu = cpuByTimestamp.get(timestamp) ?? 0;
      const memory = memoryByTimestamp.get(timestamp) ?? 0;
      return {
        cpu,
        cpuLimit,
        memory,
        memoryLimit,
        cpuRaw: Number((cpu * 1000).toFixed(2)),
        memoryRaw: memory,
        timestamp: new Date(timestamp * 1000).toISOString(),
      };
    });

    return NextResponse.json(points);
  } catch (error) {
    console.error("metrics history route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
