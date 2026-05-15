"use client";

import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type { ConfigDriftResponse } from "@/types";
import { useApiMutation, useApiQuery } from "./use-api-query";

const configDriftQueryKeys = [queryKeys.cluster.configDrift()];

export function useConfigDrift() {
  const query = useApiQuery<ConfigDriftResponse>({
    queryKey: queryKeys.cluster.configDrift(),
    path: "/api/cluster/config-drift",
    staleTime: queryStaleTimes.short,
  });

  const captureBaseline = useApiMutation<{ ok: boolean; count: number }, void>({
    path: "/api/cluster/config-drift",
    method: "POST",
    request: { json: { action: "capture" } },
    invalidateQueryKeys: configDriftQueryKeys,
    successMessage: "Baseline captured",
    errorMessage: "Failed to capture baseline",
  });

  const clearBaseline = useApiMutation<{ ok: boolean }, void>({
    path: "/api/cluster/config-drift",
    method: "DELETE",
    invalidateQueryKeys: configDriftQueryKeys,
    successMessage: "Baseline cleared",
    errorMessage: "Failed to clear baseline",
  });

  return {
    ...query,
    baselineCaptured: query.data?.baselineCaptured ?? false,
    drift: query.data?.drift ?? [],
    captureBaseline,
    clearBaseline,
  };
}
