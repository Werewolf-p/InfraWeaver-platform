"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Server } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClusterListItem {
  id: string;
  displayName: string;
}

interface ClusterListResponse {
  clusters: ClusterListItem[];
}

interface ActiveClusterResponse {
  clusterId: string;
}

export function ClusterSelector() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [savingClusterId, setSavingClusterId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const clustersQuery = useQuery<ClusterListResponse>({
    queryKey: ["clusters", "list"],
    queryFn: async () => {
      const res = await fetch("/api/clusters", { cache: "no-store" });
      if (!res.ok) return { clusters: [] };
      return res.json() as Promise<ClusterListResponse>;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const activeClusterQuery = useQuery<ActiveClusterResponse>({
    queryKey: ["clusters", "active"],
    queryFn: async () => {
      const res = await fetch("/api/clusters/active", { cache: "no-store" });
      if (!res.ok) return { clusterId: "default" };
      return res.json() as Promise<ActiveClusterResponse>;
    },
    staleTime: 5_000,
  });

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const clusters = clustersQuery.data?.clusters ?? [];
  const activeClusterId = activeClusterQuery.data?.clusterId ?? "default";
  const activeCluster = useMemo(
    () => clusters.find((cluster) => cluster.id === activeClusterId) ?? clusters[0] ?? null,
    [activeClusterId, clusters],
  );

  if (!clustersQuery.isLoading && clusters.length < 2) {
    return null;
  }

  const loading = clustersQuery.isLoading || activeClusterQuery.isLoading;

  async function selectCluster(clusterId: string) {
    if (clusterId === activeClusterId) {
      setOpen(false);
      return;
    }

    setSavingClusterId(clusterId);
    try {
      const res = await fetch("/api/clusters/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusterId }),
      });
      if (!res.ok) throw new Error("Failed to switch cluster");
      await activeClusterQuery.refetch();
      router.refresh();
      setOpen(false);
    } finally {
      setSavingClusterId(null);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-3 text-sm text-[#d9d9d9] transition-colors hover:border-[#3a3a3a] hover:text-white"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-[#7cb9ff]" /> : <Server className="h-4 w-4 text-[#7cb9ff]" />}
        <span className="max-w-[150px] truncate">{activeCluster?.displayName ?? "Cluster"}</span>
        <ChevronDown className={cn("h-4 w-4 text-[#777] transition-transform", open && "rotate-180")} />
      </button>

      {open && clusters.length > 1 ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] shadow-2xl">
          <div className="border-b border-[#2a2a2a] px-3 py-2">
            <p className="text-xs font-medium uppercase tracking-wide text-[#777]">Active cluster</p>
          </div>
          <div className="p-1.5">
            {clusters.map((cluster) => {
              const selected = cluster.id === activeClusterId;
              const saving = savingClusterId === cluster.id;
              return (
                <button
                  key={cluster.id}
                  type="button"
                  onClick={() => void selectCluster(cluster.id)}
                  disabled={saving}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    selected
                      ? "bg-[#0f2538] text-white"
                      : "text-[#d0d0d0] hover:bg-[#232323] hover:text-white",
                    saving && "opacity-60",
                  )}
                >
                  <Server className="h-4 w-4 flex-shrink-0 text-[#7cb9ff]" />
                  <span className="min-w-0 flex-1 truncate">{cluster.displayName}</span>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin text-[#7cb9ff]" /> : selected ? <Check className="h-4 w-4 text-emerald-400" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
