"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, FileText, Loader2, Power, Play, Server } from "lucide-react";
import { usePods } from "@/hooks/use-pods";
import { podsForApp, type AppIdentity } from "@/lib/pod-app-grouping";
import { StatusBadge } from "@/components/ui/status-badge";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";

function restartColor(restarts: number): string {
  if (restarts > 20) return "text-red-400";
  if (restarts > 5) return "text-amber-300";
  return "text-slate-600 dark:text-slate-300";
}

interface AppPodsDrilldownProps {
  app: AppIdentity;
  /** Other apps sharing the namespace, used to disambiguate shared-namespace pods. */
  siblingApps?: readonly AppIdentity[];
  powerState: "on" | "off";
  canPower: boolean;
  powering: boolean;
  onStop: () => void;
  onStart: () => void;
}

/**
 * Inline list of the pods that make up a single app, resolved via
 * lib/pod-app-grouping. Stopping the app scales its controllers to zero, which
 * cascades to (terminates) exactly these pods.
 */
export function AppPodsDrilldown({
  app,
  siblingApps = [],
  powerState,
  canPower,
  powering,
  onStop,
  onStart,
}: AppPodsDrilldownProps) {
  const { data: allPods = [], isLoading, error } = usePods(app.namespace);
  const pods = useMemo(
    () => podsForApp(app, allPods, siblingApps),
    [app, allPods, siblingApps],
  );

  return (
    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">
          <Server className="h-4 w-4 text-slate-500" />
          <span>
            {isLoading ? "Loading pods…" : `${pods.length} pod${pods.length === 1 ? "" : "s"}`}
          </span>
          <span className="font-mono text-xs text-gray-500 dark:text-[#9e9e9e]">{app.namespace}</span>
        </div>
        {canPower ? (
          powerState === "off" ? (
            <button
              type="button"
              onClick={onStart}
              disabled={powering}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {powering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start app
            </button>
          ) : (
            <button
              type="button"
              onClick={onStop}
              disabled={powering}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
            >
              {powering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              Stop app & pods
            </button>
          )
        ) : null}
      </div>

      {powerState === "off" ? (
        <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          App is stopped — its controllers are scaled to zero, so any pods below are terminating or already gone.
        </p>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5" />
          Could not load pods for this namespace. Select a specific cluster and try again.
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111]" />
          ))}
        </div>
      ) : pods.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-[#9e9e9e]">No pods are currently running for this app.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10 text-gray-400 dark:text-[#9a9a9a]">
                <th className="px-3 py-2 text-left font-medium">Pod</th>
                <th className="px-3 py-2 text-center font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Restarts</th>
                <th className="px-3 py-2 text-left font-medium">Age</th>
                <th className="px-3 py-2 text-right font-medium">Logs</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((pod) => {
                const restarts = pod.restartCount ?? 0;
                return (
                  <tr key={`${pod.namespace}/${pod.name}`} className="border-b border-gray-100 dark:border-white/5 last:border-0">
                    <td className="max-w-[260px] truncate px-3 py-2 font-mono text-gray-900 dark:text-[#f2f2f2]">{pod.name}</td>
                    <td className="px-3 py-2 text-center">
                      <StatusBadge status={pod.status} label={pod.status} size="sm" />
                    </td>
                    <td className={cn("px-3 py-2 font-medium", restartColor(restarts))}>{restarts}</td>
                    <td className="px-3 py-2 text-gray-500 dark:text-[#9e9e9e]">
                      <RelativeTime date={pod.createdAt} live={false} className="text-gray-500 dark:text-[#9e9e9e]" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/logs?namespace=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.name)}`}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-sky-200 transition hover:bg-sky-500/20"
                      >
                        <FileText className="h-3 w-3" />
                        Logs
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
