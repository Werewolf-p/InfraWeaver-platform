"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface RegistryTag {
  tag: string;
  digest: string;
  size: number;
  pushedAt: string | null;
}

export interface RegistryRepo {
  name: string;
  tags?: RegistryTag[];
  tagCount?: number;
}

export function useRegistryRepos() {
  return useQuery({
    queryKey: ["registry", "repos"],
    queryFn: async () => {
      const res = await fetch("/api/registry/repos");
      if (!res.ok) throw new Error("Failed to fetch registry repos");
      return res.json() as Promise<{ repositories: string[]; mock?: boolean }>;
    },
    staleTime: 60000,
  });
}

export function useRegistryTags(repo: string) {
  return useQuery({
    queryKey: ["registry", "tags", repo],
    queryFn: async () => {
      const res = await fetch(`/api/registry/repos/${encodeURIComponent(repo)}/tags`);
      if (!res.ok) throw new Error("Failed to fetch tags");
      return res.json() as Promise<{ repo: string; tags: RegistryTag[]; mock?: boolean }>;
    },
    enabled: !!repo,
    staleTime: 30000,
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ repo, tag }: { repo: string; tag: string }) => {
      const res = await fetch(`/api/registry/repos/${encodeURIComponent(repo)}/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete tag");
      return res.json();
    },
    onSuccess: (_data, { repo }) => {
      qc.invalidateQueries({ queryKey: ["registry", "tags", repo] });
      qc.invalidateQueries({ queryKey: ["registry", "repos"] });
    },
  });
}
