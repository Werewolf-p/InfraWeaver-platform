"use client";

/**
 * Client data layer for the fused Database cockpit. The read goes through the
 * dedicated signed-channel route (`GET /api/wordpress/sites/[site]/database?read=
 * analyze`) as React Query; writes POST `{ verb, params }` to the same route.
 * Mirrors `use-media.ts`. A connector too old for the `db.*` surface answers 501
 * ("update connector") — the cockpit falls back to the base wp-cli probe read-out
 * and shows the hint rather than crashing.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  DbAnalyzeResponse,
  DbCleanupParams,
  DbCleanupResponse,
  DbScheduleParams,
  DbScheduleResponse,
  DbWriteVerb,
} from "./database";

function databaseUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/database`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

/** GET the whole cockpit read-model (db.analyze). Throws with the server message on failure. */
export async function fetchDatabaseAnalyze(site: string): Promise<DbAnalyzeResponse> {
  const res = await fetch(`${databaseUrl(site)}?read=analyze`);
  if (!res.ok) {
    const err = new Error(await readError(res)) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as DbAnalyzeResponse;
}

/** POST a database write verb; throws with the server's message on failure. */
export async function postDatabaseWrite<T>(site: string, verb: DbWriteVerb, params: unknown): Promise<T> {
  const res = await fetch(databaseUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/** Preview or run a cleanup batch. `dry_run` is always explicit (preview-by-default at the wire). */
export function cleanupDatabase(site: string, params: DbCleanupParams): Promise<DbCleanupResponse> {
  return postDatabaseWrite<DbCleanupResponse>(site, "cleanup", params);
}

/** Save the automated-cleanup policy. */
export function scheduleDatabase(site: string, params: DbScheduleParams): Promise<DbScheduleResponse> {
  return postDatabaseWrite<DbScheduleResponse>(site, "schedule", params);
}

// ── query keys (co-located so panels dedupe + invalidate consistently) ─────────
export const databaseKeys = {
  analyze: (site: string) => ["wordpress-db-analyze", site] as const,
};

/**
 * The signed db.analyze read. `enabled` lets the cockpit skip the signed call for
 * a site the console knows is not entitled (the base wp-cli probe + tier upsell
 * carry that case). Kept off retry for the 501 "connector too old" and 403 cases
 * so the cockpit degrades to the base probe promptly instead of hammering.
 */
export function useDatabaseAnalyze(site: string, enabled = true): UseQueryResult<DbAnalyzeResponse, Error> {
  return useQuery({
    queryKey: databaseKeys.analyze(site),
    queryFn: () => fetchDatabaseAnalyze(site),
    enabled,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      const status = (error as Error & { status?: number }).status;
      if (status === 501 || status === 403) return false;
      return failureCount < 2;
    },
  });
}
