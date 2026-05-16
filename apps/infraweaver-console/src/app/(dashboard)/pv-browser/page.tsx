"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, HardDrive, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageScaffold } from "@/components/ui";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";

interface PV {
  name: string;
  capacity: string;
  storageClass: string;
  accessModes: string[];
  reclaimPolicy: string;
  status: string;
  claimRef: string;
  longhornHealth: string | null;
  longhornState: string | null;
}

interface PVC {
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

interface StorageResponse {
  pvs: PV[];
  pvcs: PVC[];
  live?: boolean;
}

function pvcId(pvc: Pick<PVC, "namespace" | "name">) {
  return `${pvc.namespace}/${pvc.name}`;
}

function healthBadge(health: string | null) {
  const normalized = health?.toLowerCase() ?? "unknown";
  if (normalized.includes("healthy")) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  }
  if (normalized.includes("degraded") || normalized.includes("warning")) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
  if (normalized.includes("fault") || normalized.includes("error")) {
    return "border-red-500/30 bg-red-500/10 text-red-200";
  }
  return "border-slate-700 bg-slate-950 text-slate-300";
}

export default function PvBrowserPage() {
  const queryClient = useQueryClient();
  const { can } = useRBAC();
  const canManageStorage = can("cluster:admin");
  const [activeTab, setActiveTab] = useState<"pv" | "pvc">("pv");
  const [sizeDrafts, setSizeDrafts] = useState<Record<string, string>>({});

  const { data, isLoading, isFetching, refetch } = useQuery<StorageResponse>({
    queryKey: ["storage", "pvs", "browser"],
    queryFn: async () => {
      const response = await fetch("/api/storage/pvs", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load persistent volumes");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: canManageStorage,
  });

  const pvs = data?.pvs ?? [];
  const pvcs = data?.pvcs ?? [];

  const expandMutation = useMutation({
    mutationFn: async ({ namespace, name, newSize }: { namespace: string; name: string; newSize: string }) => {
      const response = await fetch("/api/storage/expand", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, name, newSize }),
      });
      const payload = await response.json() as { error?: string; simulated?: boolean };
      if (!response.ok) throw new Error(payload.error ?? "Failed to expand PVC");
      return payload;
    },
    onSuccess: async (payload, variables) => {
      toast.success(payload.simulated ? `Expanded ${variables.name} (simulated)` : `Requested ${variables.newSize} for ${variables.name}`);
      await queryClient.invalidateQueries({ queryKey: ["storage", "pvs"] });
      await queryClient.invalidateQueries({ queryKey: ["storage", "pvs", "browser"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to expand PVC");
    },
  });

  function handleExpand(pvc: PVC) {
    const nextSize = sizeDrafts[pvcId(pvc)]?.trim();
    if (!nextSize) {
      toast.error("Enter a new PVC size, for example 50Gi");
      return;
    }
    expandMutation.mutate({ namespace: pvc.namespace, name: pvc.name, newSize: nextSize });
  }

  if (!canManageStorage) {
    return (
      <PageScaffold icon={Database} title="PV Browser" description="Persistent volume inventory and PVC expansion tools.">
        <EmptyState
          icon={ShieldAlert}
          title="Cluster admin permission required"
          description="The PV browser is restricted to cluster:admin because it exposes cluster-wide storage metadata and PVC expansion controls."
        />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      icon={Database}
      title="PV Browser"
      description="Browse persistent volumes and claims, inspect Longhorn health, and request PVC expansion from the console."
      actions={
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Refresh
        </button>
      }
      loading={isLoading}
      isEmpty={!isLoading && pvs.length === 0 && pvcs.length === 0}
      emptyState={{
        icon: HardDrive,
        title: "No storage resources found",
        description: "The console could not find any PVs or PVCs in the current cluster context.",
      }}
    >
      <div className="space-y-6">
        {data?.live === false ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Live storage data is unavailable, so the console is showing safe fallback volume metadata for UI validation.
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Persistent volumes</p>
            <p className="mt-2 text-3xl font-semibold text-white">{pvs.length}</p>
          </div>
          <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-indigo-100/80">Persistent claims</p>
            <p className="mt-2 text-3xl font-semibold text-indigo-200">{pvcs.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">Healthy Longhorn volumes</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-200">{[...pvs, ...pvcs].filter((item) => item.longhornHealth?.toLowerCase() === "healthy").length}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <div className="flex flex-wrap gap-2">
            {(["pv", "pvc"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "rounded-xl border px-4 py-2 text-sm font-medium uppercase transition-colors",
                  activeTab === tab
                    ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-200"
                    : "border-white/10 bg-slate-950 text-slate-400 hover:text-white",
                )}
              >
                {tab === "pv" ? `PVs (${pvs.length})` : `PVCs (${pvcs.length})`}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-slate-400">
            PVC expansion sends a Kubernetes PATCH request and depends on the storage class allowing volume expansion.
          </p>
        </div>

        {activeTab === "pv" ? (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Capacity</th>
                    <th className="px-4 py-3">Storage Class</th>
                    <th className="px-4 py-3">Longhorn</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Claim</th>
                  </tr>
                </thead>
                <tbody>
                  {pvs.map((pv) => (
                    <tr key={pv.name} className="border-t border-white/5">
                      <td className="px-4 py-4 font-medium text-white">{pv.name}</td>
                      <td className="px-4 py-4 text-slate-300">{pv.capacity || "—"}</td>
                      <td className="px-4 py-4 text-slate-300">{pv.storageClass || "—"}</td>
                      <td className="px-4 py-4">
                        <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", healthBadge(pv.longhornHealth))}>
                          {pv.longhornHealth ?? "n/a"}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-300">{pv.status || "—"}</td>
                      <td className="px-4 py-4 text-slate-400">{pv.claimRef || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] text-sm">
                <thead className="bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Namespace</th>
                    <th className="px-4 py-3">Requested</th>
                    <th className="px-4 py-3">Capacity</th>
                    <th className="px-4 py-3">Longhorn</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Volume</th>
                    <th className="px-4 py-3">Expand PVC</th>
                  </tr>
                </thead>
                <tbody>
                  {pvcs.map((pvc) => {
                    const id = pvcId(pvc);
                    const busy = expandMutation.isPending && expandMutation.variables?.namespace === pvc.namespace && expandMutation.variables?.name === pvc.name;
                    return (
                      <tr key={id} className="border-t border-white/5 align-top">
                        <td className="px-4 py-4 font-medium text-white">{pvc.name}</td>
                        <td className="px-4 py-4 text-slate-300">{pvc.namespace}</td>
                        <td className="px-4 py-4 text-slate-300">{pvc.requestedStorage || "—"}</td>
                        <td className="px-4 py-4 text-slate-300">{pvc.capacity || "—"}</td>
                        <td className="px-4 py-4">
                          <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", healthBadge(pvc.longhornHealth))}>
                            {pvc.longhornHealth ?? "n/a"}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-slate-300">{pvc.status || "—"}</td>
                        <td className="px-4 py-4 text-slate-400">{pvc.volumeName || "—"}</td>
                        <td className="px-4 py-4">
                          <div className="flex min-w-[240px] items-center gap-2">
                            <input
                              value={sizeDrafts[id] ?? ""}
                              onChange={(event) => setSizeDrafts((current) => ({ ...current, [id]: event.target.value }))}
                              className="w-28 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
                              placeholder="50Gi"
                            />
                            <button
                              type="button"
                              onClick={() => handleExpand(pvc)}
                              disabled={busy}
                              className="inline-flex items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-200 transition hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {busy ? "Updating…" : "Expand PVC"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </PageScaffold>
  );
}
