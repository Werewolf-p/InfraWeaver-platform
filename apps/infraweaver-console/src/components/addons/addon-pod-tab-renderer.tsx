"use client";

import { useEffect, useState, type ComponentType } from "react";
import { Loader2 } from "lucide-react";

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

  useEffect(() => {
    let active = true;
    void (load() as Promise<{ default: ComponentType<AddonPodTabProps> }>).then((mod) => {
      if (active) setView(() => mod.default);
    });
    return () => {
      active = false;
    };
  }, [load]);

  if (!View) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-6 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
      </div>
    );
  }

  return <View namespace={namespace} name={name} labels={labels} />;
}
