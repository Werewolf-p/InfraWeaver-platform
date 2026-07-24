"use client";

/**
 * Client data layer for the SEO cockpit. The counts-only snapshot is read through
 * the dedicated signed-channel route (`GET /api/wordpress/sites/[site]/seo?read=status`)
 * as React Query; the audit run, alt backfill and one-click fixes POST
 * `{ verb, params }` to the same route. Mirrors `use-media.ts` exactly so the two
 * fused surfaces share one idiom.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  SeoAltBackfillParams,
  SeoAltBackfillResponse,
  SeoAuditParams,
  SeoAuditRunResult,
  SeoFixApplyResponse,
  SeoFixParams,
  SeoStatusResponse,
  SeoWriteVerb,
} from "./seo";

function seoUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/seo`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

/** GET the counts-only SEO snapshot. */
export async function fetchSeoStatus(site: string): Promise<SeoStatusResponse> {
  const res = await fetch(`${seoUrl(site)}?read=status`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as SeoStatusResponse;
}

/** POST a SEO write verb; throws with the server's message on failure. */
export async function postSeoWrite<T>(site: string, verb: SeoWriteVerb, params: unknown): Promise<T> {
  const res = await fetch(seoUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/** Run the bounded audit (or receive the structured locked upsell). */
export function runSeoAudit(site: string, params: SeoAuditParams = {}): Promise<SeoAuditRunResult> {
  return postSeoWrite<SeoAuditRunResult>(site, "audit-run", params);
}

/** One bounded alt-text backfill batch — dry-run by default (pass `dry_run:false` to write). */
export function backfillSeoAlt(site: string, params: SeoAltBackfillParams = {}): Promise<SeoAltBackfillResponse> {
  return postSeoWrite<SeoAltBackfillResponse>(site, "alt-backfill", params);
}

/** Apply one allow-listed `_iwseo_*` fix for one post. */
export function applySeoFix(site: string, params: SeoFixParams): Promise<SeoFixApplyResponse> {
  return postSeoWrite<SeoFixApplyResponse>(site, "fix", params);
}

// ── query keys (co-located so the panel + Overview dedupe + invalidate consistently) ─
export const seoKeys = {
  status: (site: string) => ["wordpress-seo-status", site] as const,
};

export function useSeoStatus(site: string, enabled = true): UseQueryResult<SeoStatusResponse, Error> {
  return useQuery({
    queryKey: seoKeys.status(site),
    queryFn: () => fetchSeoStatus(site),
    staleTime: 20_000,
    enabled,
  });
}
