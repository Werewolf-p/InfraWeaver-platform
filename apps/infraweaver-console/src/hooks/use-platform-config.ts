"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { CatalogApp, PlatformConfigResponse } from "@/types/api";

export function usePlatformConfig() {
  return useQuery<PlatformConfigResponse>({
    queryKey: queryKeys.config.platform(),
    queryFn: async () => {
      const response = await fetch("/api/config/platform");
      if (!response.ok) throw new Error("Failed to fetch platform config");
      return response.json();
    },
    staleTime: 30_000,
  });
}

export function useCatalogApps() {
  return useQuery<CatalogApp[]>({
    queryKey: queryKeys.config.catalogApps(),
    queryFn: async () => {
      const response = await fetch("/api/config/catalog-apps");
      if (!response.ok) throw new Error("Failed to fetch catalog apps");
      return response.json();
    },
    staleTime: 30_000,
  });
}

export function useSavePlatformConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { yamlContent: string; commitMessage?: string }) => {
      const response = await fetch("/api/config/platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error("Failed to save platform config");
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.config.platform() }),
  });
}
