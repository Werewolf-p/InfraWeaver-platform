"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

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
}

export function useUsersConfig() {
  return useQuery({
    queryKey: ["config", "users"],
    queryFn: async () => {
      const res = await fetch("/api/users-config");
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json() as Promise<{ users: PlatformUser[]; sha: string; raw: string }>;
    },
    staleTime: 30000,
  });
}

export function useSaveUsersConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { users: PlatformUser[]; commitMessage?: string; sha?: string }) => {
      const res = await fetch("/api/users-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save users");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config", "users"] }),
  });
}
