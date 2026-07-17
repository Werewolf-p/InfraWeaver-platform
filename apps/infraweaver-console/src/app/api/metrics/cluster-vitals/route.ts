import { NextResponse } from "next/server";
import { isPrometheusConfigured, promScalar } from "@/lib/prometheus";
import { withAuth } from "@/lib/with-auth";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/metrics/cluster-vitals — live cluster vitals pulled straight from
// Prometheus via instant PromQL. Powers the ClusterVitalsWidget on the
// monitoring Signals board. Every metric is queried independently
// (Promise.allSettled) so one missing recording rule or exporter degrades a
// single tile to null instead of failing the whole card.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClusterVitals {
  /** Cluster-wide CPU utilisation as a percentage of allocatable cores. */
  cpuPct: number | null;
  /** Cluster-wide memory utilisation as a percentage of allocatable bytes. */
  memPct: number | null;
  /** Running pods across all namespaces. */
  runningPods: number | null;
  /** Distinct alerts currently firing (severity != none). */
  firingAlerts: number | null;
  /** Ingress requests per second (nginx), summed across controllers. */
  ingressReqPerSec: number | null;
  /** Ingress 5xx responses as a percentage of all responses. */
  ingressErrorPct: number | null;
}

export interface ClusterVitalsResponse {
  available: boolean;
  error?: string;
  vitals?: ClusterVitals;
  generatedAt?: string;
}

// PromQL kept declarative so each tile is independently swappable and one bad
// query never masks the others. Uses kube-state / node-exporter / nginx metrics
// shipped by kube-prometheus-stack.
const QUERIES = {
  cpuPct:
    '100 * sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) / sum(machine_cpu_cores or on() count(node_cpu_seconds_total{mode="idle"}))',
  memPct:
    '100 * (1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))',
  runningPods: 'sum(kube_pod_status_phase{phase="Running"})',
  firingAlerts: 'count(ALERTS{alertstate="firing",severity!="none"}) or on() vector(0)',
  ingressReqPerSec: 'sum(rate(nginx_ingress_controller_requests[5m]))',
  ingressErrorPct:
    '100 * sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) / clamp_min(sum(rate(nginx_ingress_controller_requests[5m])), 1)',
} as const satisfies Record<keyof ClusterVitals, string>;

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const GET = withAuth({ permission: "cluster:read" }, async () => {
  if (!isPrometheusConfigured()) {
    return NextResponse.json<ClusterVitalsResponse>(
      { available: false, error: "Metrics backend not configured. Set PROMETHEUS_URL environment variable." },
      { status: 503 },
    );
  }

  const keys = Object.keys(QUERIES) as Array<keyof ClusterVitals>;
  const settled = await Promise.allSettled(keys.map((key) => promScalar(QUERIES[key])));

  const vitals = {} as ClusterVitals;
  keys.forEach((key, index) => {
    const outcome = settled[index];
    const value = outcome.status === "fulfilled" ? outcome.value : null;
    // Percentages get 1 decimal; counts stay whole; req/s keeps 2 decimals.
    const digits = key === "runningPods" || key === "firingAlerts" ? 0 : key === "ingressReqPerSec" ? 2 : 1;
    vitals[key] = round(value, digits);
  });

  const anyResolved = Object.values(vitals).some((value) => value !== null);
  if (!anyResolved) {
    return NextResponse.json<ClusterVitalsResponse>(
      { available: false, error: "Prometheus reachable but returned no data for cluster vitals." },
      { status: 503 },
    );
  }

  return NextResponse.json<ClusterVitalsResponse>({
    available: true,
    vitals,
    generatedAt: new Date().toISOString(),
  });
});
