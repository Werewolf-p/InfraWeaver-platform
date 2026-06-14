"use client";

import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type { PlatformConfigResponse } from "@/types";
import { useApiQuery } from "./use-api-query";

export function usePlatformConfig() {
  return useApiQuery<PlatformConfigResponse>({
    queryKey: queryKeys.config.platform(),
    path: "/api/config/platform",
    staleTime: queryStaleTimes.short,
  });
}
