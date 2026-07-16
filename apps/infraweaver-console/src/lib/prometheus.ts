// ─────────────────────────────────────────────────────────────────────────────
// prometheus.ts — shared Prometheus range-query helper, consolidating the
// inline query_range fetches in /api/health/timeline and
// /api/metrics/history/[namespace]/[pod].
// ─────────────────────────────────────────────────────────────────────────────

import { circuitBreakers } from "@/lib/circuit-breaker";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";

/** One matrix sample: [unix seconds, value-as-string]. */
export type PromMatrixValue = [number | string, string];

export interface PromMatrixSeries {
  metric?: Record<string, string>;
  values?: PromMatrixValue[];
}

interface PrometheusMatrixResponse {
  status?: string;
  error?: string;
  errorType?: string;
  data?: { result?: PromMatrixSeries[] };
}

export interface PromQueryRangeOptions {
  /** Range start (unix seconds). */
  start: number;
  /** Range end (unix seconds). */
  end: number;
  /** Resolution step (seconds). */
  step: number;
  timeoutMs?: number;
}

/** Whether a Prometheus backend is explicitly configured via PROMETHEUS_URL. */
export function isPrometheusConfigured(): boolean {
  return Boolean(process.env.PROMETHEUS_URL);
}

/**
 * Run a PromQL range query and return ALL matrix series. Throws when the HTTP
 * call fails or Prometheus reports status !== "success" (surfacing its
 * error/errorType). Single-series callers take `result[0]?.values ?? []`.
 */
export async function promQueryRange(query: string, opts: PromQueryRangeOptions): Promise<PromMatrixSeries[]> {
  const params = new URLSearchParams({
    query,
    start: String(opts.start),
    end: String(opts.end),
    step: String(opts.step),
  });
  const response = await circuitBreakers.prometheus.call(() =>
    fetch(`${PROMETHEUS_URL}/api/v1/query_range?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    }),
  );
  const body = await response.json() as PrometheusMatrixResponse;
  if (!response.ok || body.status !== "success") {
    throw new Error(body.error ?? body.errorType ?? `Prometheus query failed (${response.status})`);
  }
  return body.data?.result ?? [];
}
