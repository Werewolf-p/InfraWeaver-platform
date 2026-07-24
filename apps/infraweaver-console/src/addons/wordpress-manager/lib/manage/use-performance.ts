"use client";

/**
 * Client data layer for the fused Performance surface. Reads go through the
 * dedicated signed-channel route (`GET /api/wordpress/sites/[site]/performance?
 * read=…`) as React Query; writes POST `{ verb, params }` to the same route. One
 * `perf.status` composite feeds the whole surface (no per-panel wp-cli fan-out);
 * `perf.audit` is a second, on-demand read for the measured-speed table.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  CacheConfigureParams,
  CacheConfigureResponse,
  CachePurgeParams,
  CachePurgeResponse,
  CacheWarmParams,
  CacheWarmResponse,
  PerfAuditResponse,
  PerfSettingsParams,
  PerfSettingsResponse,
  PerfStatusResponse,
  PerfWriteVerb,
} from "./performance";

function perfUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/performance`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

export async function fetchPerfStatus(site: string): Promise<PerfStatusResponse> {
  const res = await fetch(`${perfUrl(site)}?read=status`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as PerfStatusResponse;
}

export async function fetchPerfAudit(site: string, rows?: number): Promise<PerfAuditResponse> {
  const q = rows ? `&p=${encodeURIComponent(JSON.stringify({ rows }))}` : "";
  const res = await fetch(`${perfUrl(site)}?read=audit${q}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as PerfAuditResponse;
}

/** POST a performance write verb; throws with the server's message on failure. */
export async function postPerfWrite<T>(site: string, verb: PerfWriteVerb, params: unknown): Promise<T> {
  const res = await fetch(perfUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

// Typed write helpers (the panel imports these — the params type is checked here).
export const purgeCache = (site: string, params: CachePurgeParams): Promise<CachePurgeResponse> =>
  postPerfWrite(site, "purge", params);
export const warmCache = (site: string, params: CacheWarmParams): Promise<CacheWarmResponse> =>
  postPerfWrite(site, "warm", params);
export const configureCache = (site: string, params: CacheConfigureParams): Promise<CacheConfigureResponse> =>
  postPerfWrite(site, "configure", params);
export const setPerfSettings = (site: string, params: PerfSettingsParams): Promise<PerfSettingsResponse> =>
  postPerfWrite(site, "settings", params);

// ── query keys (co-located so the surface dedupes + invalidates consistently) ──
export const perfKeys = {
  status: (site: string) => ["wordpress-perf-status", site] as const,
  audit: (site: string) => ["wordpress-perf-audit", site] as const,
};

export function usePerfStatus(site: string): UseQueryResult<PerfStatusResponse, Error> {
  return useQuery({ queryKey: perfKeys.status(site), queryFn: () => fetchPerfStatus(site), staleTime: 15_000 });
}

export function usePerfAudit(site: string, enabled = true): UseQueryResult<PerfAuditResponse, Error> {
  return useQuery({
    queryKey: perfKeys.audit(site),
    queryFn: () => fetchPerfAudit(site),
    enabled,
    staleTime: 20_000,
  });
}
