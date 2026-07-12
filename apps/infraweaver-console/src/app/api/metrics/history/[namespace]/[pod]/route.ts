import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { requireLogsTargetAccess } from "@/lib/logs-route-helpers";
import { parseCpuQuantity, parseMemoryBytes } from "@/lib/k8s-quantity";
import { makeCoreApi } from "@/lib/kube-client";
import { promQueryRange, type PromMatrixValue } from "@/lib/prometheus";
import { safeError } from "@/lib/utils";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";

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

async function queryRangeValues(query: string, start: number, end: number, step: number) {
  const series = await promQueryRange(query, { start, end, step });
  return series[0]?.values ?? [];
}

function valuesToMap(values: PromMatrixValue[]) {
  return new Map(
    values.map(([timestamp, value]) => [Number(timestamp), Number.parseFloat(value ?? "0")]),
  );
}

export const GET = withAuth<{ namespace: string; pod: string }>(
  { permission: "apps:read" },
  async ({ req, session, params }) => {
    const { namespace, pod } = params;
    if (!isValidNamespace(namespace) || !isValidK8sName(pod)) {
      return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
    }

    const access = await requireLogsTargetAccess(session, namespace, pod);
    if (access instanceof NextResponse) return access;

    try {
      const coreApi = makeCoreApi(getRequestClusterId(req));
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
        queryRangeValues(cpuQuery, startTime, endTime, HISTORY_STEP_SECONDS),
        queryRangeValues(memoryQuery, startTime, endTime, HISTORY_STEP_SECONDS),
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
  },
);
