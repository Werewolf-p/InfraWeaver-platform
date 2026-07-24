"use client";

/**
 * Client hooks for the Content / Branding / Config surfaces. Reads ride the
 * dedicated signed-channel route (`/api/wordpress/sites/[site]/content-branding`);
 * writes POST `{ verb, params }` to the same route. Every method maps to a signed
 * connector command server-side — this hook NEVER introduces a public endpoint.
 *
 * These mirror the media Explorer's data hooks: React Query for reads, a thin
 * mutation for writes, uniform query-key invalidation on success.
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BrandingGetResponse,
  BrandingSetParams,
  BrandingSetResult,
  ConfigApplyResult,
  ConfigGetResponse,
  ConfigSetParams,
  ContentBrandingWriteVerb,
  ContentDuplicateResult,
} from "../../../lib/manage/content-branding";

const BASE = "/api/wordpress/sites";

function readUrl(site: string, read: "branding" | "config"): string {
  return `${BASE}/${encodeURIComponent(site)}/content-branding?read=${read}`;
}

async function fetchRead<T>(site: string, read: "branding" | "config"): Promise<T> {
  const res = await fetch(readUrl(site, read));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load ${read} (${res.status})`);
  }
  return (await res.json()) as T;
}

async function postWrite<T>(site: string, verb: ContentBrandingWriteVerb, params: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${encodeURIComponent(site)}/content-branding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Operation failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function brandingKey(site: string): readonly [string, string] {
  return ["wordpress-branding", site];
}
export function configKey(site: string): readonly [string, string] {
  return ["wordpress-config", site];
}

export interface ReadState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
}

export function useBranding(site: string, enabled = true): ReadState<BrandingGetResponse> {
  const query = useQuery({
    queryKey: brandingKey(site),
    queryFn: () => fetchRead<BrandingGetResponse>(site, "branding"),
    staleTime: 15_000,
    enabled,
  });
  return {
    data: query.data,
    loading: query.isPending && query.fetchStatus !== "idle",
    error: query.error instanceof Error ? query.error.message : query.error ? "Failed to load" : null,
    reload: () => void query.refetch(),
  };
}

export function useConfig(site: string, enabled = true): ReadState<ConfigGetResponse> {
  const query = useQuery({
    queryKey: configKey(site),
    queryFn: () => fetchRead<ConfigGetResponse>(site, "config"),
    staleTime: 15_000,
    enabled,
  });
  return {
    data: query.data,
    loading: query.isPending && query.fetchStatus !== "idle",
    error: query.error instanceof Error ? query.error.message : query.error ? "Failed to load" : null,
    reload: () => void query.refetch(),
  };
}

export interface BrandingWriter {
  save(settings: BrandingSetParams["settings"]): Promise<BrandingSetResult>;
  readonly pending: boolean;
}

export function useBrandingWriter(site: string): BrandingWriter {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (settings: BrandingSetParams["settings"]) =>
      postWrite<BrandingSetResult>(site, "branding-set", { settings }),
  });
  const save = useCallback(
    async (settings: BrandingSetParams["settings"]) => {
      const result = await mutation.mutateAsync(settings);
      if (result.ok) await qc.invalidateQueries({ queryKey: [...brandingKey(site)] });
      return result;
    },
    [mutation, qc, site],
  );
  return { save, pending: mutation.isPending };
}

export interface ConfigWriter {
  apply(values: ConfigSetParams["values"]): Promise<ConfigApplyResult>;
  readonly pending: boolean;
}

export function useConfigWriter(site: string): ConfigWriter {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (values: ConfigSetParams["values"]) => postWrite<ConfigApplyResult>(site, "config-set", { values }),
  });
  const apply = useCallback(
    async (values: ConfigSetParams["values"]) => {
      const result = await mutation.mutateAsync(values);
      await qc.invalidateQueries({ queryKey: [...configKey(site)] });
      return result;
    },
    [mutation, qc, site],
  );
  return { apply, pending: mutation.isPending };
}

export interface DuplicateWriter {
  duplicate(postId: number): Promise<ContentDuplicateResult>;
  readonly pending: boolean;
}

export function useDuplicateWriter(site: string): DuplicateWriter {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (postId: number) => postWrite<ContentDuplicateResult>(site, "content-duplicate", { post_id: postId }),
  });
  const duplicate = useCallback(
    async (postId: number) => {
      const result = await mutation.mutateAsync(postId);
      if (result.ok) await qc.invalidateQueries({ queryKey: ["wordpress-manage-panel", site] });
      return result;
    },
    [mutation, qc, site],
  );
  return { duplicate, pending: mutation.isPending };
}
