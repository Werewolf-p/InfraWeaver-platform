"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSettingsContext } from "@/contexts/settings-context";

export interface ArgoApp {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: {
    destination: { namespace: string; server: string };
    project: string;
    source?: { repoURL?: string; path?: string; targetRevision?: string };
  };
  status: {
    health: { status: "Healthy" | "Progressing" | "Degraded" | "Suspended" | "Missing" | "Unknown" };
    sync: { status: "Synced" | "OutOfSync" | "Unknown"; revision?: string };
    conditions?: { type: string; message: string; lastTransitionTime: string }[];
    operationState?: {
      phase: string;
      startedAt: string;
      finishedAt?: string;
      message?: string;
      syncResult?: { revision?: string };
    };
    summary?: { images?: string[]; externalURLs?: string[] };
    reconciledAt?: string;
  };
}

export function useArgoApps() {
  const { settings } = useSettingsContext();
  return useQuery<ArgoApp[]>({
    queryKey: ["argocd", "apps"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps");
      if (!res.ok) throw new Error("Failed to fetch apps");
      return res.json();
    },
    refetchInterval: settings.refreshInterval,
    staleTime: 15000,
  });
}

export function useSyncApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, hard }: { name: string; hard?: boolean }) => {
      const res = await fetch(`/api/argocd/apps/${name}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hard }),
      });
      if (!res.ok) throw new Error("Sync failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["argocd", "apps"] }),
  });
}
