"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ManageOverview } from "../../../lib/manage/types";
import type { ManageAction } from "../../../lib/manage/actions";
import type { ManagePanelId } from "../../../lib/manage/capabilities";

/**
 * Data hooks for the Manage console. Built on React Query — the same fetching
 * layer the Connector view uses — so overview/panel reads are cached, shared and
 * deduped client-side, on top of the server's stale-while-revalidate snapshot
 * cache. A reopened tab paints from the query cache immediately and reconciles.
 */

/** Async resource state shared by the overview + panel hooks. */
export interface AsyncState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401) return "Sign in to view this site.";
  if (res.status === 403) return "You don't have access to this site.";
  return `Request failed (${res.status}).`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Fetch the Manage overview (capabilities + summary) for a site. */
export function useManageOverview(site: string): AsyncState<ManageOverview> {
  const query = useQuery({
    queryKey: ["wordpress-manage-overview", site],
    queryFn: () => fetchJson<ManageOverview>(`/api/wordpress/sites/${site}/manage`),
    staleTime: 20_000,
  });
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: errorMessage(query.error),
    reload: () => void query.refetch(),
  };
}

/**
 * Fetch one panel's live data. Only fires when `enabled` (so a hidden tab never
 * hits the API). The generic `T` is the panel's data type (e.g. `UpdatesData`).
 */
export function useManagePanel<T>(site: string, panel: ManagePanelId, enabled = true): AsyncState<T> {
  const query = useQuery({
    queryKey: ["wordpress-manage-panel", site, panel],
    queryFn: async () => {
      const body = await fetchJson<{ panel: string; data: T }>(`/api/wordpress/sites/${site}/manage/${panel}`);
      return body.data;
    },
    enabled,
    staleTime: 15_000,
  });
  return {
    data: query.data ?? null,
    loading: enabled && query.isPending,
    error: errorMessage(query.error),
    reload: () => void query.refetch(),
  };
}

/**
 * Run an allow-listed Manage write action; resolves to the server's result. On
 * success it invalidates the site's overview + panel queries so the UI reflects
 * the mutation (the server also drops its snapshot cache for the site).
 */
export function useManageAction(site: string): {
  run(action: ManageAction): Promise<{ ok: boolean; message: string }>;
  pending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (action: ManageAction): Promise<{ ok: boolean; message: string }> => {
      try {
        const res = await fetch(`/api/wordpress/sites/${site}/manage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        });
        if (!res.ok) return { ok: false, message: await readError(res) };
        const body = (await res.json()) as { ok?: boolean; message?: string };
        return { ok: body.ok !== false, message: body.message ?? "Done." };
      } catch (err: unknown) {
        return { ok: false, message: err instanceof Error ? err.message : "Action failed." };
      }
    },
    onSuccess: (result) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: ["wordpress-manage-overview", site] });
      void queryClient.invalidateQueries({ queryKey: ["wordpress-manage-panel", site] });
    },
  });
  return { run: (action) => mutation.mutateAsync(action), pending: mutation.isPending };
}
