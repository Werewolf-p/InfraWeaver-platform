"use client";

/**
 * The fused Performance surface — the anti-silo move. ONE panel where the four
 * old wp-admin sections collapse into a narrative: Measured speed ("how fast is
 * it?") → Page cache ("the biggest lever") → Optimizations ("the fine levers") →
 * Server posture (facts). Managed zones (cache / speed-pack / lazy-load) ride ONE
 * signed `perf.status` composite (no per-panel wp-cli fan-out) and the dedicated
 * signed route for actions; server posture reuses the existing wp-cli probe. Both
 * transports are first-class (in-cluster pods and external §5 sites). Locked
 * features render an upsell via TierGate, never a dead end.
 */

import { useCallback, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Cpu, Gauge, Lightbulb, MemoryStick, Server, Sliders, Timer, Trash2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { PerformanceData } from "../../../lib/manage/probes/performance";
import { SectionCard, StatTile, healthTone } from "../../demo/widgets";
import { PanelState, Spinner } from "../../demo/manage/panel-shell";
import { useManagePanel } from "../../demo/manage/use-manage";
import { EmptyState, Pill, PostureCheck } from "../../demo/manage/kit";
import { TierGate } from "../kit/tier-gate";
import { useSiteEntitlements } from "../../../lib/manage/use-site-entitlements";
import {
  configureCache,
  perfKeys,
  purgeCache,
  setPerfSettings,
  usePerfStatus,
  warmCache,
} from "../../../lib/manage/use-performance";
import type { LazyLoadSettings, PerfStatusResponse, SpeedPackSettings } from "../../../lib/manage/performance";
import { cacheVerdict } from "../../../lib/manage/performance-view";
import { PageCacheControls } from "./perf-cache-controls";
import { LazyLoadControls, SpeedPackControls } from "./perf-optimizations";
import { PerfAuditTable } from "./perf-audit-table";

const AUTOLOAD_WARN_KB = 800;

export function PerformancePanel({ site }: { site: string }): ReactNode {
  const qc = useQueryClient();
  const status = usePerfStatus(site);
  const ent = useSiteEntitlements(site);
  const [busy, setBusy] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: perfKeys.status(site) });
    void qc.invalidateQueries({ queryKey: perfKeys.audit(site) });
  }, [qc, site]);

  /** Run one action with a shared busy id, a success toast, and a snapshot refresh. */
  const run = useCallback(
    async (id: string, fn: () => Promise<string>) => {
      setBusy(id);
      try {
        const okMsg = await fn();
        toast.success(okMsg);
        invalidate();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      } finally {
        setBusy(null);
      }
    },
    [invalidate],
  );

  const cacheActable = ent.has("page_cache") && !ent.isSwitchedOff("page_cache") && ent.connectorActive;

  const onToggleCache = useCallback(
    (on: boolean) =>
      run("configure", async () => {
        const res = await configureCache(site, { enabled: on });
        if (res.locked) throw new Error("Page Cache isn't included in this site's plan.");
        if (res.ok === false) throw new Error(res.manual_step ?? res.reason ?? "Could not update the page cache.");
        return on ? "Page cache turned on" : "Page cache turned off";
      }),
    [run, site],
  );

  const onSaveConfig = useCallback(
    (ttl: number, exclusions: string[]) =>
      run("configure", async () => {
        const res = await configureCache(site, { ttl, exclusions });
        if (res.locked) throw new Error("Page Cache isn't included in this site's plan.");
        if (res.ok === false) throw new Error(res.reason ?? "Could not save cache settings.");
        return "Cache settings saved";
      }),
    [run, site],
  );

  const onPurgeAll = useCallback(
    () =>
      run("purge-all", async () => {
        const res = await purgeCache(site, { scope: "all" });
        return `Cleared ${res.purged.toLocaleString()} cached page(s)`;
      }),
    [run, site],
  );

  const onPurgeUrl = useCallback(
    (path: string) =>
      run("purge-url", async () => {
        const res = await purgeCache(site, { scope: "paths", paths: [path] });
        return `Purged ${res.purged} cached entr${res.purged === 1 ? "y" : "ies"} for ${path}`;
      }),
    [run, site],
  );

  const onWarm = useCallback(
    () =>
      run("warm", async () => {
        const res = await warmCache(site, {});
        if (res.locked) throw new Error("Cache warming isn't included in this site's plan.");
        return `Warmed ${res.warmed}, skipped ${res.skipped}, failed ${res.failed}`;
      }),
    [run, site],
  );

  const onSaveSpeedPack = useCallback(
    (next: SpeedPackSettings) =>
      run("speedpack", async () => {
        const res = await setPerfSettings(site, { speed_pack: next });
        if (res.speed_pack?.locked) throw new Error("Speed Pack isn't included in this site's plan.");
        if (res.speed_pack && res.speed_pack.ok === false) throw new Error(res.speed_pack.reason ?? "Could not save optimizations.");
        return "Optimizations updated";
      }),
    [run, site],
  );

  const onSaveLazyLoad = useCallback(
    (next: LazyLoadSettings) =>
      run("lazyload", async () => {
        const res = await setPerfSettings(site, { lazy_load: next });
        if (res.lazy_load?.locked) throw new Error("Lazy Loading isn't included in this site's plan.");
        if (res.lazy_load && res.lazy_load.ok === false) throw new Error(res.lazy_load.reason ?? "Could not save lazy loading.");
        return "Lazy loading updated";
      }),
    [run, site],
  );

  const managed = status.data;
  const managedError = status.error?.message ?? null;

  return (
    <div className="space-y-5">
      <SpeedStrip managed={managed} />

      {managedError ? <ManagedUnavailable message={managedError} /> : null}

      <SectionCard title="Measured speed" description="Your slowest real pages, with a one-click fix per row." icon={Timer}>
        <PerfAuditTable
          site={site}
          cacheEnabled={managed?.page_cache.enabled ?? false}
          canActOnCache={cacheActable}
          busy={busy !== null}
          onPurgeUrl={onPurgeUrl}
          onEnableCache={() => onToggleCache(true)}
        />
      </SectionCard>

      <SectionCard title="Page cache" description="Serve whole pages from cache — the biggest single speed lever." icon={Zap}>
        <TierGate site={site} flag="page_cache">
          {managed ? (
            <PageCacheControls
              status={managed.page_cache}
              busy={busy}
              onToggle={onToggleCache}
              onPurgeAll={onPurgeAll}
              onWarm={onWarm}
              onSaveConfig={onSaveConfig}
            />
          ) : (
            <ZoneSkeleton />
          )}
        </TierGate>
      </SectionCard>

      <SectionCard title="Optimizations" description="Fine levers — flip each one and see what it does." icon={Sliders}>
        <div className="space-y-5">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Speed pack</h4>
            <TierGate site={site} flag="speed_pack">
              {managed ? (
                <SpeedPackControls settings={managed.speed_pack.settings} status={managed.speed_pack.status} busy={busy} onSave={onSaveSpeedPack} />
              ) : (
                <ZoneSkeleton />
              )}
            </TierGate>
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Lazy loading</h4>
            <TierGate site={site} flag="lazy_load">
              {managed ? <LazyLoadControls settings={managed.lazy_load} busy={busy} onSave={onSaveLazyLoad} /> : <ZoneSkeleton />}
            </TierGate>
          </div>
        </div>
      </SectionCard>

      <ServerPosture site={site} />
    </div>
  );
}

/** Top strip — the one-glance verdict combining measured avg ms and cache hit-rate. */
function SpeedStrip({ managed }: { managed: PerfStatusResponse | undefined }): ReactNode {
  if (!managed) return null;
  const verdict = cacheVerdict(managed.page_cache);
  const avgMs = managed.audit.avg_ms;
  const good = verdict.tone === "good" && avgMs > 0 && avgMs < 800;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-4 rounded-2xl border p-5",
        good ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5",
      )}
    >
      <span
        className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
          good ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        )}
      >
        <Gauge className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{verdict.label}</p>
        <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          {avgMs > 0 ? `Real pages build in about ${avgMs.toLocaleString()} ms on average.` : "No measured page views yet."}
        </p>
      </div>
      <Pill tone={good ? "good" : "warn"}>{good ? "Fast" : "Room to improve"}</Pill>
    </div>
  );
}

/** Graceful-degradation banner: the signed cache surface is unavailable, but posture still works. */
function ManagedUnavailable({ message }: { message: string }): ReactNode {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <Server className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
      <p className="text-zinc-600 dark:text-zinc-300">
        Cache and optimization controls are unavailable right now: {message} The server-posture facts below still work.
      </p>
    </div>
  );
}

function ZoneSkeleton(): ReactNode {
  return <div className="h-28 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-800/40" aria-hidden />;
}

/** Zone D — the existing wp-cli server-posture facts + derived recommendations. */
function ServerPosture({ site }: { site: string }): ReactNode {
  const state = useManagePanel<PerformanceData>(site, "performance");
  return (
    <SectionCard title="Server posture" description="Object cache, PHP runtime and stored-data weight, read live from the site." icon={Server}>
      <PanelState state={state}>
        {(data) => {
          const autoloadHigh = data.autoloadKb !== null && data.autoloadKb > AUTOLOAD_WARN_KB;
          const objectLabel = data.persistentObjectCache
            ? data.cacheType && !/default/i.test(data.cacheType)
              ? data.cacheType
              : "Drop-in"
            : "None";
          return (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <PostureRow label="Object cache" tone={data.persistentObjectCache ? "good" : "neutral"} value={objectLabel} />
                <PostureRow
                  label="Page cache"
                  tone={data.pageCache ? "good" : "neutral"}
                  value={data.pageCache === "iwsl" ? "Built-in" : data.pageCache ?? "None"}
                />
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400">PHP</span>
                  <span className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{data.php ?? "—"}</span>
                </div>
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Memory limit</span>
                  <span className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{data.memoryLimit ?? "—"}</span>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <StatTile label="Autoload weight" value={data.autoloadKb ?? 0} decimals={1} suffix=" KB" icon={MemoryStick} tone={healthTone(autoloadHigh ? 55 : 92)} />
                <StatTile label="Transients" value={data.transients} icon={Trash2} tone={healthTone(data.transients > 500 ? 55 : 90)} />
              </div>

              {data.recommendations.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    <Lightbulb className="h-3.5 w-3.5" aria-hidden /> Recommendations
                  </div>
                  <ul className="space-y-2">
                    {data.recommendations.map((rec) => (
                      <PostureCheck key={rec} state="recommended" label={rec} />
                    ))}
                  </ul>
                </div>
              ) : (
                <EmptyState icon={Cpu} title="Server posture looks healthy" body="No object-cache, autoload or transient issues from the live signals." />
              )}
            </div>
          );
        }}
      </PanelState>
    </SectionCard>
  );
}

function PostureRow({ label, value, tone }: { label: string; value: string; tone: "good" | "neutral" }): ReactNode {
  return (
    <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      <Pill tone={tone}>{value}</Pill>
    </div>
  );
}
