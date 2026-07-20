"use client";

// Performance ("Speed") panel — cache posture, autoload weight, PHP runtime and
// derived recommendations, all read live from the site. It leads with a plain-
// language verdict so a non-technical owner knows at a glance whether the site is
// fast. The three tuning actions (flush cache, flush rewrites, purge transients)
// go through the allow-listed Manage actions; everything else is read-only.
import { Cpu, Gauge, Lightbulb, MemoryStick, RefreshCw, Trash2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { PerformanceData } from "../../../lib/manage/probes/performance";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";
import { BTN, BTN_SM } from "./manage-ui";
import { EmptyState, Pill, PostureCheck } from "./kit";

const AUTOLOAD_WARN_KB = 800;
const TRANSIENT_WARN = 500;

/** A cache-posture row: label on the left, an On/Off pill (with the backend detail) on the right. */
function CacheRow({ label, on, detail }: { label: string; on: boolean; detail?: string | null }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="flex items-center gap-2">
        {on && detail ? <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{detail}</span> : null}
        <Pill tone={on ? "good" : "neutral"}>{on ? "On" : "Off"}</Pill>
      </dd>
    </div>
  );
}

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
        const issueCount = data.recommendations.length;
        // Verdict combines the recommendation signals with cache posture: a fast
        // site has nothing to improve AND a persistent object cache in effect.
        const speedGood = issueCount === 0 && data.persistentObjectCache;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div
              className={cn(
                "flex flex-wrap items-center gap-4 rounded-2xl border p-5 lg:col-span-2",
                speedGood ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5",
              )}
            >
              <span
                className={cn(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
                  speedGood
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                <Gauge className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Speed: {speedGood ? "Good" : "Needs work"}
                </p>
                <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                  {speedGood
                    ? "No speed issues from the live cache, autoload and transient signals."
                    : `${issueCount} thing${issueCount === 1 ? "" : "s"} we can improve — see the list below.`}
                </p>
              </div>
              <Pill tone={speedGood ? "good" : "warn"}>{speedGood ? "Good" : "Needs work"}</Pill>
            </div>

            <SectionCard title="Caching" description="Object cache and page-cache posture." icon={Zap}>
              <dl className="space-y-2">
                <CacheRow label="Object cache" on={data.persistentObjectCache} detail={cacheLabel === "None" ? null : cacheLabel} />
                <CacheRow label="Page cache" on={data.pageCachePlugin !== null} detail={data.pageCachePlugin} />
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  title="Flush cache"
                  onClick={() => apply({ type: "flush-cache" })}
                  disabled={pending}
                  className={BTN}
                >
                  {pending ? <Spinner /> : <Zap className="h-4 w-4" aria-hidden />} Clear cached pages
                </button>
                <button
                  type="button"
                  title="Flush rewrites"
                  onClick={() => apply({ type: "flush-rewrites" })}
                  disabled={pending}
                  className={BTN}
                >
                  {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Fix broken links (permalinks)
                </button>
                <button
                  type="button"
                  title="Purge transients"
                  onClick={() => apply({ type: "purge-transients" })}
                  disabled={pending}
                  className={BTN}
                >
                  {pending ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />} Clear temporary data
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
              <StatTile label="Transients" value={data.transients} icon={Trash2} tone={healthTone(data.transients > TRANSIENT_WARN ? 55 : 90)} />
            </div>

            <SectionCard
              className="lg:col-span-2"
              title="Recommendations"
              description="Derived from the live cache, autoload and transient signals."
              icon={Lightbulb}
            >
              {issueCount === 0 ? (
                <EmptyState
                  icon={Gauge}
                  title="No speed issues detected."
                  body="Nothing to improve from the live cache, autoload and transient signals."
                />
              ) : (
                <ul className="space-y-2">
                  {data.recommendations.map((rec) => (
                    <PostureCheck
                      key={rec}
                      state="recommended"
                      label={rec}
                      action={
                        /transient/i.test(rec) ? (
                          <button
                            type="button"
                            title="Purge transients"
                            className={BTN_SM}
                            disabled={pending}
                            onClick={() => apply({ type: "purge-transients" })}
                          >
                            {pending ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />} Purge
                          </button>
                        ) : undefined
                      }
                    />
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
