"use client";

import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type { CatalogApp, PlatformConfigResponse } from "@/types";
import { useApiMutation, useApiQuery } from "./use-api-query";

export function usePlatformConfig() {
  return useApiQuery<PlatformConfigResponse>({
    queryKey: queryKeys.config.platform(),
    path: "/api/config/platform",
    staleTime: queryStaleTimes.short,
  });
}

export function useCatalogApps() {
  return useApiQuery<CatalogApp[]>({
    queryKey: queryKeys.config.catalogApps(),
    path: "/api/config/catalog-apps",
    staleTime: queryStaleTimes.short,
  });
}

export function useSavePlatformConfig() {
  return useApiMutation<PlatformConfigResponse, { yamlContent: string; commitMessage?: string }>({
    path: "/api/config/platform",
    method: "PUT",
    invalidateQueryKeys: [queryKeys.config.platform()],
    errorMessage: "Failed to save platform config",
  });
}
