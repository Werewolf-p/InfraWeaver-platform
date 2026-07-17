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

/** One instant-vector sample: label set + [unix seconds, value-as-string]. */
export interface PromVectorSeries {
  metric?: Record<string, string>;
  value?: PromMatrixValue;
}

interface PrometheusVectorResponse {
  status?: string;
  error?: string;
  errorType?: string;
  data?: { resultType?: string; result?: PromVectorSeries[] };
}

/**
 * Run a PromQL instant query (`/api/v1/query`) and return ALL vector series.
 * Throws when the HTTP call fails or Prometheus reports status !== "success".
 */
export async function promQueryInstant(query: string, timeoutMs = 5000): Promise<PromVectorSeries[]> {
  const params = new URLSearchParams({ query });
  const response = await circuitBreakers.prometheus.call(() =>
    fetch(`${PROMETHEUS_URL}/api/v1/query?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  const body = await response.json() as PrometheusVectorResponse;
  if (!response.ok || body.status !== "success") {
    throw new Error(body.error ?? body.errorType ?? `Prometheus query failed (${response.status})`);
  }
  return body.data?.result ?? [];
}

/**
 * Convenience for single-value gauges: run an instant query and return the first
 * series' numeric value, or `null` when the query yields no samples (an empty
 * result is normal for e.g. "no alerts firing", so callers treat null as "0/none"
 * rather than an error).
 */
export async function promScalar(query: string, timeoutMs = 5000): Promise<number | null> {
  const series = await promQueryInstant(query, timeoutMs);
  const raw = series[0]?.value?.[1];
  if (raw === undefined) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}
