"use client";

import { useMemo } from "react";
import { HardDrive } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useApiQuery } from "@/hooks/use-api-query";

interface PvcEntry {
  namespace: string;
  name: string;
  storageClass: string;
  accessModes: string[];
  requestedStorage: string;
  capacity: string;
  status: string;
  volumeName: string;
  longhornHealth: string | null;
  longhornState: string | null;
}

interface PvcsResponse {
  pvcs: PvcEntry[];
  live?: boolean;
}

function toStatusBadge(status?: string) {
  const value = (status ?? "unknown").toLowerCase();
  if (value === "bound") return "healthy" as const;
  if (value === "pending") return "progressing" as const;
  if (value === "lost" || value === "failed") return "degraded" as const;
  return "unknown" as const;
}

/**
 * Storage tab for a single app — lists the PersistentVolumeClaims bound in the
 * app's namespace, reusing the shared /api/storage/pvcs source (cluster:admin).
 */
export function AppStoragePanel({ namespace }: { namespace: string }) {
  const { data, isLoading, error } = useApiQuery<PvcsResponse>({
    queryKey: ["app-storage", namespace],
    enabled: Boolean(namespace),
    path: "/api/storage/pvcs",
    request: { cache: "no-store" },
    staleTime: 30_000,
  });

  const pvcs = useMemo(
    () => (data?.pvcs ?? []).filter((pvc) => pvc.namespace === namespace),
    [data?.pvcs, namespace],
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-6 text-sm text-slate-500 dark:text-slate-400">
        Storage details require cluster:admin permission.
      </div>
    );
  }

  if (pvcs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-6 text-sm text-slate-500 dark:text-slate-400">
        No PersistentVolumeClaims found in namespace <span className="font-mono">{namespace}</span>.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {pvcs.map((pvc) => (
        <div
          key={`${pvc.namespace}/${pvc.name}`}
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            <HardDrive className="h-5 w-5 shrink-0 text-slate-400" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{pvc.name}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {pvc.storageClass || "—"} · {pvc.accessModes.join(", ") || "—"}
                {pvc.longhornHealth ? ` · Longhorn ${pvc.longhornHealth}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-900 dark:text-white">{pvc.capacity || pvc.requestedStorage || "—"}</span>
            <StatusBadge status={toStatusBadge(pvc.status)} size="sm" />
          </div>
        </div>
      ))}
    </div>
  );
}
