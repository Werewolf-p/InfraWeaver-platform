"use client";

/**
 * Client data layer for the Site Health surface. The panel's aggregate data
 * (checklist + broken links + 404s + maintenance) rides the `health` Manage panel
 * (`useManagePanel`), so this module only adds the DETAIL read (the full redirect
 * table) and the WRITE verbs, all against the dedicated signed-channel route
 * (`/api/wordpress/sites/[site]/site-health`) and the maintenance orchestrator
 * (`/maintenance`). Every write invalidates the `health` panel so the snapshot
 * refreshes.
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "@/lib/notify";
import type {
  MaintenanceSetResult,
  RedirectCreateParams,
  RedirectImportParams,
  RedirectMutationResult,
  RedirectTogglesParams,
  RedirectImportResult,
  RedirectTogglesResult,
  RedirectsListResult,
  LinkScanSummary,
} from "./site-health";

function siteHealthUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/site-health`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

/** GET the full redirect table (signed `redirects.list`). */
export async function fetchRedirects(site: string): Promise<RedirectsListResult> {
  const res = await fetch(`${siteHealthUrl(site)}?read=redirects`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as RedirectsListResult;
}

/** POST a site-health write verb; throws with the server's message on failure. */
export async function postSiteHealthWrite<T>(site: string, verb: string, params: unknown): Promise<T> {
  const res = await fetch(siteHealthUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/** Rich maintenance PUT through the orchestrator (mutual exclusion server-side). */
export interface MaintenancePutBody {
  readonly enabled: boolean;
  readonly headline?: string;
  readonly message?: string;
  readonly retryAfter?: boolean;
  readonly until?: number;
  readonly allowIps?: readonly string[];
}

export async function putMaintenance(site: string, body: MaintenancePutBody): Promise<unknown> {
  const res = await fetch(`/api/wordpress/sites/${encodeURIComponent(site)}/maintenance`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

// ── query keys ─────────────────────────────────────────────────────────────────
export const siteHealthKeys = {
  redirects: (site: string) => ["wordpress-site-health-redirects", site] as const,
  panel: (site: string) => ["wordpress-manage-panel", site] as const,
};

/** The full redirect table, fetched only when the manager sub-tab is open. */
export function useRedirects(site: string, enabled: boolean): UseQueryResult<RedirectsListResult> {
  return useQuery({
    queryKey: siteHealthKeys.redirects(site),
    queryFn: () => fetchRedirects(site),
    enabled,
    staleTime: 15_000,
  });
}

export interface SiteHealthActions {
  readonly scan: (budgetMs?: number) => Promise<LinkScanSummary>;
  readonly createRedirect: (params: RedirectCreateParams) => Promise<RedirectMutationResult>;
  readonly deleteRedirect: (id: string) => Promise<RedirectMutationResult>;
  readonly importRedirects: (params: RedirectImportParams) => Promise<RedirectImportResult>;
  readonly setToggles: (params: RedirectTogglesParams) => Promise<RedirectTogglesResult>;
  readonly setMaintenance: (body: MaintenancePutBody) => Promise<unknown>;
  readonly pending: boolean;
}

/**
 * The write surface for the panel — each verb POSTs the signed route (or PUTs the
 * maintenance orchestrator) and invalidates the `health` panel + redirect table so
 * the snapshot and the manager table both reconcile. Refusal tokens from the
 * connector gauntlet (e.g. `duplicate-source`) flow back to the caller verbatim.
 */
export function useSiteHealthActions(site: string): SiteHealthActions {
  const queryClient = useQueryClient();

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: siteHealthKeys.panel(site) }),
      queryClient.invalidateQueries({ queryKey: siteHealthKeys.redirects(site) }),
    ]);
  }, [queryClient, site]);

  const mutation = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
  });

  const withInvalidate = useCallback(
    async <T,>(run: () => Promise<T>, onError = true): Promise<T> => {
      try {
        const result = (await mutation.mutateAsync(run as () => Promise<unknown>)) as T;
        await invalidate();
        return result;
      } catch (err) {
        if (onError) toast.error(err instanceof Error ? err.message : "Operation failed");
        throw err;
      }
    },
    [mutation, invalidate],
  );

  return {
    pending: mutation.isPending,
    scan: (budgetMs) =>
      withInvalidate(() => postSiteHealthWrite<LinkScanSummary>(site, "scan", budgetMs ? { budget_ms: budgetMs } : {})),
    // Redirect create/delete refusals are DATA (per-row reasons), not thrown — so
    // suppress the generic error toast and let the caller render the reason token.
    createRedirect: (params) =>
      withInvalidate(() => postSiteHealthWrite<RedirectMutationResult>(site, "redirect-create", params), false),
    deleteRedirect: (id) =>
      withInvalidate(() => postSiteHealthWrite<RedirectMutationResult>(site, "redirect-delete", { id }), false),
    importRedirects: (params) =>
      withInvalidate(() => postSiteHealthWrite<RedirectImportResult>(site, "redirect-import", params)),
    setToggles: (params) =>
      withInvalidate(() => postSiteHealthWrite<RedirectTogglesResult>(site, "redirect-toggles", params)),
    setMaintenance: (body) => withInvalidate(() => putMaintenance(site, body)),
  };
}
