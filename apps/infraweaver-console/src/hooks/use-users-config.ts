"use client";

import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type { PlatformUser, UsersConfigResponse } from "@/types";
import { useApiMutation, useApiQuery } from "./use-api-query";

export type { PlatformUser } from "@/types";

export function useUsersConfig() {
  return useApiQuery<UsersConfigResponse<PlatformUser>>({
    queryKey: queryKeys.config.users(),
    path: "/api/users-config",
    staleTime: queryStaleTimes.short,
  });
}

export function useSaveUsersConfig() {
  return useApiMutation<UsersConfigResponse<PlatformUser>, { users: PlatformUser[]; commitMessage?: string; sha?: string }>({
    path: "/api/users-config",
    method: "POST",
    invalidateQueryKeys: [queryKeys.config.users()],
    errorMessage: "Failed to save users",
  });
}
