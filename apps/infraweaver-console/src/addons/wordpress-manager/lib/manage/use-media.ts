"use client";

/**
 * Client data layer for the fused Media Explorer. Reads go through the dedicated
 * signed-channel route (`GET /api/wordpress/sites/[site]/media?read=…`) as React
 * Query; writes POST `{ verb, params }` to the same route. `selectAllMatchingIds`
 * is the honest select-all-matching helper — it asks the server for the whole
 * matching id set (`include_ids`) and loops the filtered pages when the server
 * caps, reusing the pure `collectMatchingIds` core.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { collectMatchingIds, type MatchingSelection } from "./media-batch";
import {
  MATCH_IDS_MAX,
  PER_PAGE_MAX,
  type MediaGetResponse,
  type MediaListParams,
  type MediaListResponse,
  type MediaStatusResponse,
  type MediaTreeResponse,
  type MediaUsageResponse,
  type MediaWriteVerb,
} from "./media";

function mediaUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/media`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

/** GET a media read verb. `list` carries its params as a JSON `p` query param. */
export async function fetchMediaList(site: string, params: MediaListParams): Promise<MediaListResponse> {
  const p = encodeURIComponent(JSON.stringify(params));
  const res = await fetch(`${mediaUrl(site)}?read=list&p=${p}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MediaListResponse;
}

export async function fetchMediaTree(site: string): Promise<MediaTreeResponse> {
  const res = await fetch(`${mediaUrl(site)}?read=tree`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MediaTreeResponse;
}

export async function fetchMediaStatus(site: string): Promise<MediaStatusResponse> {
  const res = await fetch(`${mediaUrl(site)}?read=status`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MediaStatusResponse;
}

/** GET the full viewer detail for one asset (`media.get`). */
export async function fetchMediaAsset(site: string, id: number): Promise<MediaGetResponse> {
  const p = encodeURIComponent(JSON.stringify({ id }));
  const res = await fetch(`${mediaUrl(site)}?read=get&p=${p}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MediaGetResponse;
}

/** GET the bounded where-used scan for one asset (`media.usage`). */
export async function fetchMediaUsage(site: string, id: number, page = 1): Promise<MediaUsageResponse> {
  const p = encodeURIComponent(JSON.stringify({ id, page }));
  const res = await fetch(`${mediaUrl(site)}?read=usage&p=${p}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MediaUsageResponse;
}

/** POST a media write verb; throws with the server's message on failure. */
export async function postMediaWrite<T>(site: string, verb: MediaWriteVerb, params: unknown): Promise<T> {
  const res = await fetch(mediaUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

// ── query keys (co-located so panels dedupe + invalidate consistently) ─────────
export const mediaKeys = {
  list: (site: string, params: MediaListParams) => ["wordpress-media-list", site, params] as const,
  tree: (site: string) => ["wordpress-media-tree", site] as const,
  status: (site: string) => ["wordpress-media-status", site] as const,
  asset: (site: string, id: number) => ["wordpress-media-asset", site, id] as const,
  usage: (site: string, id: number, page: number) => ["wordpress-media-usage", site, id, page] as const,
};

export function useMediaList(site: string, params: MediaListParams): UseQueryResult<MediaListResponse, Error> {
  return useQuery({
    queryKey: mediaKeys.list(site, params),
    queryFn: () => fetchMediaList(site, params),
    staleTime: 15_000,
    // Keep the prior page visible while the next filter/page loads (no flash).
    placeholderData: (prev) => prev,
  });
}

export function useMediaTree(site: string): UseQueryResult<MediaTreeResponse, Error> {
  return useQuery({ queryKey: mediaKeys.tree(site), queryFn: () => fetchMediaTree(site), staleTime: 20_000 });
}

export function useMediaStatus(site: string): UseQueryResult<MediaStatusResponse, Error> {
  return useQuery({ queryKey: mediaKeys.status(site), queryFn: () => fetchMediaStatus(site), staleTime: 15_000 });
}

/** The full viewer detail for one asset; `enabled` gates it to an open viewer. */
export function useMediaAsset(site: string, id: number | null): UseQueryResult<MediaGetResponse, Error> {
  return useQuery({
    queryKey: mediaKeys.asset(site, id ?? 0),
    queryFn: () => fetchMediaAsset(site, id as number),
    enabled: typeof id === "number" && id > 0,
    staleTime: 10_000,
  });
}

/** The bounded where-used list for one asset (viewer Usage panel). */
export function useMediaUsage(site: string, id: number | null, page = 1): UseQueryResult<MediaUsageResponse, Error> {
  return useQuery({
    queryKey: mediaKeys.usage(site, id ?? 0, page),
    queryFn: () => fetchMediaUsage(site, id as number, page),
    enabled: typeof id === "number" && id > 0,
    staleTime: 10_000,
  });
}

/**
 * Resolve the full id set matching the active filter — the mechanism behind
 * "select all non-lossless". One `include_ids` call returns up to MATCH_IDS_MAX;
 * on a capped result it walks the filtered pages (per_page = PER_PAGE_MAX) to
 * gather the overflow.
 */
export async function selectAllMatchingIds(site: string, base: MediaListParams): Promise<MatchingSelection> {
  return collectMatchingIds({
    fetchMatchIds: async () => {
      const res = await fetchMediaList(site, { ...base, page: 1, per_page: PER_PAGE_MAX, include_ids: true });
      return {
        ids: res.ids ?? [],
        capped: res.ids_capped === true,
        total: res.total,
        perPage: res.per_page || PER_PAGE_MAX,
      };
    },
    fetchPageIds: async (page) => {
      const res = await fetchMediaList(site, { ...base, page, per_page: PER_PAGE_MAX });
      return res.items.map((item) => item.id);
    },
    maxIds: MATCH_IDS_MAX * 4,
  });
}
