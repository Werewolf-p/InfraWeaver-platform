"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSettingsContext } from "@/contexts/settings-context";

export interface ArgoApp {
  metadata: { name: string; namespace: string; labels?: Record<string, string>; creationTimestamp?: string };
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

export type ArgoAppsDataSource = "argocd-api" | "crd" | "last-known" | "mock";

interface ArgoAppsResponse {
  apps: ArgoApp[];
  dataSource: ArgoAppsDataSource | null;
}

function isArgoAppsDataSource(value: string | null): value is ArgoAppsDataSource {
  return value === "argocd-api" || value === "crd" || value === "last-known" || value === "mock";
}

async function getErrorMessage(response: Response) {
  try {
    const data = await response.json() as { error?: string };
    return data.error ?? `Failed to fetch apps (${response.status})`;
  } catch {
    return `Failed to fetch apps (${response.status})`;
  }
}

export function useArgoApps() {
  const { settings } = useSettingsContext();
  const query = useQuery<ArgoAppsResponse, Error>({
    queryKey: ["argocd", "apps"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps", { cache: "no-store" });
      if (!res.ok) throw new Error(await getErrorMessage(res));

      const headerValue = res.headers.get("X-Data-Source");
      const dataSource: ArgoAppsDataSource | null = isArgoAppsDataSource(headerValue) ? headerValue : null;
      const apps = await res.json() as ArgoApp[];

      return { apps, dataSource };
    },
    refetchInterval: settings.refreshInterval,
    staleTime: 15000,
  });

  return {
    ...query,
    data: query.data?.apps ?? [],
    dataSource: query.data?.dataSource ?? null,
  } as typeof query & { data: ArgoApp[]; dataSource: ArgoAppsDataSource | null };
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
