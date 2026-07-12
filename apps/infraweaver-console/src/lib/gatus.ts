// ─────────────────────────────────────────────────────────────────────────────
// gatus.ts — shared Gatus status fetch + uptime math, consolidating the inline
// copies in /api/health, /api/health/sla and /api/health/reliability.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_GATUS_URL = process.env.GATUS_URL ?? "http://gatus.gatus.svc.cluster.local:8080";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_SIZE = 100;

export interface GatusResult {
  success: boolean;
  timestamp?: string;
  duration?: number;
}

export interface GatusEndpointStatus {
  name: string;
  group: string;
  results: GatusResult[];
}

export interface FetchGatusStatusesOptions {
  /** Override the Gatus base URL (e.g. a per-cluster gatusUrl). */
  baseUrl?: string;
  pageSize?: number;
  timeoutMs?: number;
}

/**
 * Fetch endpoint statuses from Gatus, normalized across versions:
 * v5 returns a bare array, v5.7+ may return a paginated { results, total }
 * object, and per-check success may live on `success` or `conditionResults`.
 * Throws when Gatus is unreachable/non-2xx so callers keep their own fallbacks.
 */
export async function fetchGatusStatuses(opts: FetchGatusStatusesOptions = {}): Promise<GatusEndpointStatus[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_GATUS_URL;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const response = await fetch(`${baseUrl}/api/v1/endpoints/statuses?page=1&pageSize=${pageSize}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Gatus request failed (${response.status})`);

  const raw = await response.json() as unknown;
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { results?: unknown[] }).results)
      ? (raw as { results: unknown[] }).results
      : [];

  return items.map((item) => {
    const endpoint = item as {
      name?: string;
      group?: string;
      results?: Array<{ success?: boolean; timestamp?: string; duration?: number; conditionResults?: Array<{ success: boolean }> }>;
    };
    const results = (endpoint.results ?? []).map((result) => ({
      success: typeof result.success === "boolean"
        ? result.success
        : (result.conditionResults ?? []).every((condition) => condition.success),
      ...(result.timestamp !== undefined ? { timestamp: result.timestamp } : {}),
      ...(result.duration !== undefined ? { duration: result.duration } : {}),
    }));
    return { name: endpoint.name ?? "Unknown", group: endpoint.group ?? "", results };
  });
}

/**
 * Uptime percentage over the trailing `windowHours` window. Results without a
 * timestamp always count (matching the existing routes); an empty window is
 * 100. Raw percentage by default; pass `decimals` (e.g. 2, as /api/health/sla
 * does) to round.
 */
export function calcUptime(
  results: Array<{ success: boolean; timestamp?: string }>,
  windowHours: number,
  decimals?: number,
): number {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const filtered = results.filter((result) => {
    if (!result.timestamp) return true;
    return now - new Date(result.timestamp).getTime() <= windowMs;
  });
  if (!filtered.length) return 100;
  const percentage = (filtered.filter((result) => result.success).length / filtered.length) * 100;
  if (decimals === undefined) return percentage;
  const factor = 10 ** decimals;
  return Math.round(percentage * factor) / factor;
}
