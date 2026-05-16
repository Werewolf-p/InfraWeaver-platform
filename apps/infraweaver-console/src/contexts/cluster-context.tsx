"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

export interface ClusterInfo {
  id: string;
  name: string;
  description: string;
  status: "healthy" | "degraded" | "offline" | "unknown";
  isLocal: boolean;
  tags: string[];
  lastSeen: string;
}

export type ActiveClusterId = string | "all";

interface ClusterContextValue {
  clusters: ClusterInfo[];
  activeId: ActiveClusterId;
  setActiveId: (id: ActiveClusterId) => void;
  activeCluster: ClusterInfo | null; // null when "all"
  isLoading: boolean;
  /** true when a non-local cluster (or all) is selected */
  isRemote: boolean;
}

const STORAGE_KEY = "infraweaver:active-cluster";

const ClusterContext = createContext<ClusterContextValue>({
  clusters: [],
  activeId: "local",
  setActiveId: () => undefined,
  activeCluster: null,
  isLoading: false,
  isRemote: false,
});

export function ClusterProvider({ children }: { children: React.ReactNode }) {
  const [activeId, setActiveIdState] = useState<ActiveClusterId>(() => {
    if (typeof window === "undefined") return "local";
    try { return (localStorage.getItem(STORAGE_KEY) as ActiveClusterId) ?? "local"; }
    catch { return "local"; }
  });

  const { data, isLoading } = useQuery<{ clusters: ClusterInfo[] }>({
    queryKey: ["clusters", "list"],
    queryFn: async () => {
      const res = await fetch("/api/clusters");
      if (!res.ok) return { clusters: [] };
      return res.json() as Promise<{ clusters: ClusterInfo[] }>;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const clusters = useMemo<ClusterInfo[]>(() => data?.clusters ?? [], [data]);

  const setActiveId = useCallback((id: ActiveClusterId) => {
    setActiveIdState(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
    // Sync with HTTP-only cookie so server-side API routes see the change
    if (id !== "all") {
      fetch("/api/clusters/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusterId: id }),
      }).catch(() => { /* best-effort */ });
    }
  }, []);

  // On mount, sync localStorage with the server-side cookie
  useEffect(() => {
    fetch("/api/clusters/active")
      .then(r => r.ok ? r.json() : null)
      .then((data: { clusterId: string } | null) => {
        if (data?.clusterId && data.clusterId !== activeId) {
          setActiveIdState(data.clusterId);
          try { localStorage.setItem(STORAGE_KEY, data.clusterId); } catch { /* ignore */ }
        }
      })
      .catch(() => { /* ignore */ });
  // Only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the stored cluster no longer exists in the configured list, fall back to the
  // first available cluster (not hardcoded "local", which may not exist).
  useEffect(() => {
    if (!isLoading && clusters.length > 0 && activeId !== "all") {
      const exists = clusters.some((c) => c.id === activeId);
      if (!exists) setActiveId(clusters[0]!.id);
    }
  }, [clusters, isLoading, activeId, setActiveId]);

  const activeCluster = useMemo(
    () => (activeId === "all" ? null : (clusters.find((c) => c.id === activeId) ?? null)),
    [clusters, activeId],
  );

  const isRemote = activeId !== "local";

  return (
    <ClusterContext.Provider value={{ clusters, activeId, setActiveId, activeCluster, isLoading, isRemote }}>
      {children}
    </ClusterContext.Provider>
  );
}

export function useCluster() {
  return useContext(ClusterContext);
}
