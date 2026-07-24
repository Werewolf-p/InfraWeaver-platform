"use client";

/**
 * Client data layer for the Insights surface. Reads go through the dedicated
 * signed-channel route (`GET /api/wordpress/sites/[site]/insights?read=…`) as
 * React Query. The thrown error preserves the HTTP status so a 501 (connector
 * too old) is distinguishable from a transient failure — `deriveInsightsView`
 * branches on it. A signed `{ locked, gate }` is a NORMAL success (locked:true),
 * not an error, so the honest teaser is rendered from the response body.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  DEFAULT_SERIES_DAYS,
  DEFAULT_STATS_RANGE,
  type ActivityLogParams,
  type ActivityLogResponse,
  type StatsRange,
  type StatsSummaryParams,
  type StatsSummaryResponse,
  type StatsTimeseriesParams,
  type StatsTimeseriesResponse,
} from "./insights";

/** An error carrying the HTTP status, so 501 (connector too old) is detectable. */
export class InsightsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "InsightsError";
    this.status = status;
  }
}

function insightsUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/insights`;
}

async function readError(res: Response): Promise<InsightsError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new InsightsError(body.error ?? `Request failed (${res.status})`, res.status);
}

async function getRead<T>(site: string, verb: string, params: unknown): Promise<T> {
  const p = encodeURIComponent(JSON.stringify(params ?? {}));
  const res = await fetch(`${insightsUrl(site)}?read=${verb}&p=${p}`);
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export function fetchStatsSummary(site: string, params: StatsSummaryParams): Promise<StatsSummaryResponse> {
  return getRead<StatsSummaryResponse>(site, "summary", params);
}

export function fetchStatsTimeseries(site: string, params: StatsTimeseriesParams): Promise<StatsTimeseriesResponse> {
  return getRead<StatsTimeseriesResponse>(site, "timeseries", params);
}

export function fetchActivityLog(site: string, params: ActivityLogParams): Promise<ActivityLogResponse> {
  return getRead<ActivityLogResponse>(site, "activity", params);
}

// ── query keys (co-located so panels dedupe + invalidate consistently) ─────────
export const insightsKeys = {
  summary: (site: string, range: StatsRange) => ["wordpress-insights-summary", site, range] as const,
  timeseries: (site: string, days: number) => ["wordpress-insights-timeseries", site, days] as const,
  activity: (site: string, limit: number) => ["wordpress-insights-activity", site, limit] as const,
};

export function useStatsSummary(
  site: string,
  range: StatsRange = DEFAULT_STATS_RANGE,
): UseQueryResult<StatsSummaryResponse, InsightsError> {
  return useQuery({
    queryKey: insightsKeys.summary(site, range),
    queryFn: () => fetchStatsSummary(site, { range_days: range }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    // A connector-too-old (501) or locked read won't heal on retry — don't hammer.
    retry: false,
  });
}

export function useStatsTimeseries(
  site: string,
  days: number = DEFAULT_SERIES_DAYS,
): UseQueryResult<StatsTimeseriesResponse, InsightsError> {
  return useQuery({
    queryKey: insightsKeys.timeseries(site, days),
    queryFn: () => fetchStatsTimeseries(site, { days }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

export function useActivityLog(
  site: string,
  limit: number,
  enabled = true,
): UseQueryResult<ActivityLogResponse, InsightsError> {
  return useQuery({
    queryKey: insightsKeys.activity(site, limit),
    queryFn: () => fetchActivityLog(site, { limit }),
    staleTime: 30_000,
    enabled,
    retry: false,
  });
}
