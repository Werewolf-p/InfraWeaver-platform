"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog, RelativeTime } from "@/components/ui";
import { useApiMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import type { EsLifecycle } from "@/lib/secrets/lifecycle-types";

export interface EsLifecycleTableProps {
  items: EsLifecycle[];
  canRemediate: boolean;
}

function esId(es: Pick<EsLifecycle, "namespace" | "name">) {
  return `${es.namespace}/${es.name}`;
}

export function EsLifecycleTable({ items, canRemediate }: EsLifecycleTableProps) {
  const [syncTarget, setSyncTarget] = useState<EsLifecycle | null>(null);

  const forceSync = useApiMutation<{ ok: boolean }, { namespace: string; name: string }>({
    path: "/api/security/force-sync-secret",
    request: (vars) => ({ json: vars }),
    successMessage: (_, vars) => `Force-sync requested for ${vars.name}`,
    invalidateQueryKeys: [queryKeys.secrets.lifecycle()],
    onSuccess: () => setSyncTarget(null),
  });

  if (items.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">No ExternalSecrets found in the selected scope.</p>;
  }

  // Surface the problem rows first: retain-traps, then not-ready, then healthy.
  const sorted = [...items].sort((a, b) => {
    const rank = (es: EsLifecycle) => (es.isRetainTrap ? 0 : !es.ready ? 1 : 2);
    return rank(a) - rank(b);
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-slate-100 dark:bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-4 py-3">ExternalSecret</th>
              <th className="px-4 py-3">Ready</th>
              <th className="px-4 py-3">Policy</th>
              <th className="px-4 py-3">Missing keys</th>
              <th className="px-4 py-3">Last sync</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((es) => (
              <tr key={esId(es)} className="border-t border-gray-200 dark:border-white/5 align-top">
                <td className="px-4 py-4">
                  <p className="font-medium text-gray-900 dark:text-white">{es.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{es.namespace}</p>
                  {es.isRetainTrap ? (
                    <span className="mt-1.5 inline-block rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-300">
                      Retain trap
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-4">
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", es.ready ? "border-green-500/20 bg-green-500/10 text-green-400" : "border-red-500/20 bg-red-500/10 text-red-400")}>
                    {es.ready ? "Ready" : "Not ready"}
                  </span>
                </td>
                <td className="px-4 py-4 text-slate-600 dark:text-slate-300">{es.deletionPolicy || "—"}</td>
                <td className="px-4 py-4">
                  {es.missingKeys.length === 0 ? (
                    <span className="text-slate-500">—</span>
                  ) : (
                    <div className="flex max-w-sm flex-wrap gap-1.5">
                      {es.missingKeys.map((key) => (
                        <span key={key} className="rounded-full border border-orange-500/20 bg-orange-500/10 px-2 py-0.5 text-xs font-mono text-orange-300">{key}</span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-4 text-slate-500 dark:text-slate-400"><RelativeTime date={es.lastSync} /></td>
                <td className="px-4 py-4 text-right">
                  {canRemediate ? (
                    <button
                      type="button"
                      onClick={() => setSyncTarget(es)}
                      disabled={forceSync.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      Force sync
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(syncTarget)}
        onConfirm={() => syncTarget ? forceSync.mutate({ namespace: syncTarget.namespace, name: syncTarget.name }) : undefined}
        onCancel={() => setSyncTarget(null)}
        title={syncTarget ? `Force-sync ${syncTarget.name}?` : "Force-sync ExternalSecret?"}
        description="Annotates the ExternalSecret to trigger an immediate re-sync from OpenBao. If keys are still missing, a Retain-policy secret will fail again."
        confirmText={forceSync.isPending ? "Syncing…" : "Force sync"}
      />
    </div>
  );
}
