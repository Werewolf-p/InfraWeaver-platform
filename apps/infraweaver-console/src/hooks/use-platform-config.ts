"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function usePlatformConfig() {
  return useQuery({
    queryKey: ["config", "platform"],
    queryFn: async () => {
      const res = await fetch("/api/config/platform");
      if (!res.ok) throw new Error("Failed to fetch platform config");
      return res.json() as Promise<{ raw: string; sha: string; catalog: Record<string, unknown>; groups: Record<string, unknown> }>;
    },
    staleTime: 30000,
  });
}

export function useSavePlatformConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { yamlContent: string; commitMessage?: string }) => {
      const res = await fetch("/api/config/platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save platform config");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config", "platform"] }),
  });
}
