"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

export interface AddonPodTabProps {
  namespace: string;
  name: string;
  labels: Record<string, string>;
}

/**
 * Loads and mounts an addon-contributed pod tab. The component (default export
 * from the addon's manifest `podTabs[].component`) receives the pod's namespace,
 * name, and labels — everything it needs to scope itself to this pod without the
 * core app knowing anything addon-specific. The dynamic import is module-cached
 * by the bundler, so remounts are cheap.
 */
export function AddonPodTabRenderer({
  load,
  namespace,
  name,
  labels,
}: AddonPodTabProps & { load: () => Promise<unknown> }) {
  const [View, setView] = useState<ComponentType<AddonPodTabProps> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    (load() as Promise<{ default: ComponentType<AddonPodTabProps> }>)
      .then((mod) => {
        if (active) setView(() => mod.default);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      active = false;
    };
  }, [load, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setView(null);
    setAttempt((value) => value + 1);
  }, []);

  if (error && !View) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 p-6 text-sm"
      >
        <div className="flex items-center gap-2 font-medium text-red-500 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> This panel failed to load
        </div>
        <p className="text-slate-500 dark:text-slate-400">
          {error.message || "The addon module could not be loaded. This is usually a temporary network hiccup."}
        </p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors hover:border-[#0078D4]/40 hover:text-gray-900 dark:hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
        </button>
      </div>
    );
  }

  if (!View) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-6 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
      </div>
    );
  }

  return <View namespace={namespace} name={name} labels={labels} />;
}
