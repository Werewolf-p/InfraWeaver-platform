"use client";

import { Search } from "lucide-react";
import type { Pod } from "@/hooks/use-pods";
import { cn } from "@/lib/utils";

function statusDot(status: string) {
  const value = status.toLowerCase();
  if (value === "running") return "bg-emerald-400";
  if (value === "pending") return "bg-amber-400";
  if (value === "failed") return "bg-red-400";
  if (value === "succeeded" || value === "completed") return "bg-sky-400";
  return "bg-slate-500";
}

interface PodSelectorTreeProps {
  pods: Pod[];
  search: string;
  onSearchChange: (value: string) => void;
  selectedKey?: string;
  onSelect: (pod: Pod) => void;
}

export function PodSelectorTree({
  pods,
  search,
  onSearchChange,
  selectedKey,
  onSelect,
}: PodSelectorTreeProps) {
  const query = search.trim().toLowerCase();

  const grouped = pods.reduce<Record<string, Pod[]>>((accumulator, pod) => {
    const matches =
      !query ||
      pod.name.toLowerCase().includes(query) ||
      pod.namespace.toLowerCase().includes(query) ||
      pod.status.toLowerCase().includes(query);

    if (!matches) return accumulator;
    accumulator[pod.namespace] ??= [];
    accumulator[pod.namespace].push(pod);
    return accumulator;
  }, {});

  const namespaces = Object.keys(grouped).sort((left, right) => left.localeCompare(right));

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950/40">
      <div className="border-b border-white/10 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search pods or namespaces..."
            className="w-full rounded-lg border border-white/10 bg-slate-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {namespaces.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-slate-950/60 px-4 py-8 text-center text-sm text-slate-500">
            No pods match the current filter.
          </div>
        ) : (
          namespaces.map((namespace) => (
            <div key={namespace} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{namespace}</p>
                <span className="text-[11px] text-slate-600">{grouped[namespace].length}</span>
              </div>

              <div className="space-y-1.5">
                {grouped[namespace]
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((pod) => {
                    const key = `${pod.namespace}/${pod.name}`;
                    return (
                      <button
                        key={key}
                        onClick={() => onSelect(pod)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition",
                          selectedKey === key
                            ? "border-indigo-500/40 bg-indigo-500/10 text-white"
                            : "border-white/5 bg-white/[0.03] text-slate-300 hover:border-white/10 hover:bg-white/[0.05]"
                        )}
                      >
                        <span className={cn("mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full", statusDot(pod.status))} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{pod.name}</span>
                          <span className="mt-1 block truncate text-xs text-slate-500">
                            {pod.status} · {pod.containers.length} container{pod.containers.length === 1 ? "" : "s"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
