// ─────────────────────────────────────────────────────────────────────────────
// loki.ts — shared Loki (LogQL) range-query helper. Mirrors prometheus.ts so the
// console can surface aggregated / historical logs from the in-cluster Loki that
// promtail already ships every pod's stdout to — unlike /api/logs, which reads a
// single live pod via the K8s API (tail-capped, no history for rotated/crashed
// pods, no cross-pod search).
// ─────────────────────────────────────────────────────────────────────────────

import { circuitBreakers } from "@/lib/circuit-breaker";

const LOKI_URL = process.env.LOKI_URL ?? "http://loki.monitoring.svc.cluster.local:3100";

/** One log entry: nanosecond-epoch timestamp (string) + the raw line. */
export type LokiEntry = { ts: string; line: string };

/** A single Loki stream: its label set plus the matched entries (newest-first). */
export interface LokiStream {
  labels: Record<string, string>;
  entries: LokiEntry[];
}

interface LokiQueryResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{ stream?: Record<string, string>; values?: Array<[string, string]> }>;
  };
}

export interface LokiQueryRangeOptions {
  /** Range start (unix seconds). */
  start: number;
  /** Range end (unix seconds). */
  end: number;
  /** Max entries to return (Loki caps at its server limit, typically 5000). */
  limit: number;
  timeoutMs?: number;
}

/** Whether a Loki backend is explicitly configured via LOKI_URL. */
export function isLokiConfigured(): boolean {
  return Boolean(process.env.LOKI_URL);
}

const SECONDS_TO_NANOS = 1_000_000_000;

/**
 * Run a LogQL range query and return the matched streams, flattened and sorted
 * newest-first. Throws when the HTTP call fails or Loki reports a non-success
 * status. Callers build the LogQL selector; this never interpolates user input
 * into the query string itself.
 */
export async function lokiQueryRange(logql: string, opts: LokiQueryRangeOptions): Promise<LokiStream[]> {
  const params = new URLSearchParams({
    query: logql,
    start: String(opts.start * SECONDS_TO_NANOS),
    end: String(opts.end * SECONDS_TO_NANOS),
    limit: String(opts.limit),
    direction: "backward",
  });
  const response = await circuitBreakers.loki.call(() =>
    fetch(`${LOKI_URL}/loki/api/v1/query_range?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    }),
  );
  const body = (await response.json()) as LokiQueryResponse;
  if (!response.ok || body.status !== "success") {
    throw new Error(`Loki query failed (${response.status})`);
  }
  return (body.data?.result ?? []).map((stream) => ({
    labels: stream.stream ?? {},
    entries: (stream.values ?? []).map(([ts, line]) => ({ ts, line })),
  }));
}

/**
 * Fetch the distinct values of a Loki label (e.g. "namespace") over a window.
 * Used to populate the namespace picker without a second data source.
 */
export async function lokiLabelValues(label: string, startSeconds: number, endSeconds: number, timeoutMs = 5000): Promise<string[]> {
  const params = new URLSearchParams({
    start: String(startSeconds * SECONDS_TO_NANOS),
    end: String(endSeconds * SECONDS_TO_NANOS),
  });
  const response = await circuitBreakers.loki.call(() =>
    fetch(`${LOKI_URL}/loki/api/v1/label/${encodeURIComponent(label)}/values?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  const body = (await response.json()) as { status?: string; data?: string[] };
  if (!response.ok || body.status !== "success") {
    throw new Error(`Loki label query failed (${response.status})`);
  }
  return body.data ?? [];
}
