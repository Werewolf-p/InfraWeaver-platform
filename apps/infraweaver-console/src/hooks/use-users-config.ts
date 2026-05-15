"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { UsersConfigResponse } from "@/types/api";

export interface NasShareAssignment {
  provider: "synology" | "truenas";
  share: string;
  subfolder?: string;
  access: "readonly" | "readwrite";
  pvc_namespace?: string;
  pvc_name?: string;
  created_at?: string;
}

export interface PlatformUser {
  username: string;
  name: string;
  email: string;
  access_level: string;
  wiki_role?: string;
  authentik_groups?: string[];
  argocd_role?: string;
  nas_shares?: NasShareAssignment[];
  role_assignments?: Array<{
    id: string;
    roleId: string;
    scope: string;
    principalType?: "user" | "group";
    principalId?: string;
    grantedBy: string;
    grantedAt: string;
    expiresAt?: string;
  }>;
}

export function useUsersConfig() {
  return useQuery<UsersConfigResponse<PlatformUser>>({
    queryKey: queryKeys.config.users(),
    queryFn: async () => {
      const response = await fetch("/api/users-config");
      if (!response.ok) throw new Error("Failed to fetch users");
      return response.json();
    },
    staleTime: 30_000,
  });
}

export function useSaveUsersConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { users: PlatformUser[]; commitMessage?: string; sha?: string }) => {
      const response = await fetch("/api/users-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error("Failed to save users");
      return response.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.config.users() }),
  });
}
