"use client";

// Performance panel — cache posture, autoload weight, PHP runtime and derived
// recommendations, all read live from the site. The three tuning actions (flush
// cache, flush rewrites, purge transients) go through the allow-listed Manage
// actions; everything else is read-only.
import { Cpu, Gauge, Lightbulb, MemoryStick, RefreshCw, Trash2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { PerformanceData } from "../../../lib/manage/probes/performance";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const AUTOLOAD_WARN_KB = 800;

export function PerformancePanel({ site }: { site: string }) {
  const state = useManagePanel<PerformanceData>(site, "performance");
  const { run, pending } = useManageAction(site);

  async function apply(action: Parameters<typeof run>[0]) {
    const result = await run(action);
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
  }

  return (
    <PanelState state={state}>
      {(data) => {
        const cacheLabel = data.persistentObjectCache
          ? data.cacheType && !/default/i.test(data.cacheType)
            ? data.cacheType
            : "Drop-in"
          : "None";
        const autoloadHigh = data.autoloadKb !== null && data.autoloadKb > AUTOLOAD_WARN_KB;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Caching" description="Object cache and page-cache posture." icon={Zap}>
              <dl className="space-y-2">
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Object cache</dt>
                  <dd>
                    <span className={cn(PILL, data.persistentObjectCache ? TONE_PILL.good : TONE_PILL.neutral)}>{cacheLabel}</span>
                  </dd>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Page cache</dt>
                  <dd>
                    <span className={cn(PILL, data.pageCachePlugin ? TONE_PILL.good : TONE_PILL.neutral)}>
                      {data.pageCachePlugin ?? "None"}
                    </span>
                  </dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => apply({ type: "flush-cache" })} disabled={pending} className={BTN}>
                  {pending ? <Spinner /> : <Zap className="h-4 w-4" aria-hidden />} Flush cache
                </button>
                <button type="button" onClick={() => apply({ type: "flush-rewrites" })} disabled={pending} className={BTN}>
                  {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Flush rewrites
                </button>
                <button type="button" onClick={() => apply({ type: "purge-transients" })} disabled={pending} className={BTN}>
                  {pending ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />} Purge transients
                </button>
              </div>
            </SectionCard>

            <SectionCard title="PHP runtime" description="Interpreter version and memory ceiling." icon={Cpu}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">PHP version</span>
                  <span className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">{data.php ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Memory limit</span>
                  <span className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">{data.memoryLimit ?? "—"}</span>
                </div>
              </div>
            </SectionCard>

            <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
              <StatTile
                label="Autoload weight"
                value={data.autoloadKb ?? 0}
                decimals={1}
                suffix=" KB"
                icon={MemoryStick}
                tone={healthTone(autoloadHigh ? 55 : 92)}
              />
              <StatTile label="Transients" value={data.transients} icon={Trash2} tone={healthTone(data.transients > 500 ? 55 : 90)} />
            </div>

            <SectionCard
              className="lg:col-span-2"
              title="Recommendations"
              description="Derived from the live cache, autoload and transient signals."
              icon={Lightbulb}
            >
              {data.recommendations.length === 0 ? (
                <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
                  <Gauge className="h-5 w-5 text-emerald-500" aria-hidden />
                  No performance issues detected from these signals.
                </div>
              ) : (
                <ul className="space-y-2">
                  {data.recommendations.map((rec) => (
                    <li
                      key={rec}
                      className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300"
                    >
                      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                      <span>{rec}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
