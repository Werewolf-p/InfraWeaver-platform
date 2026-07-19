"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  Cpu,
  Gauge,
  HeartPulse,
  KeyRound,
  Monitor,
  RefreshCw,
  Rocket,
  ServerCrash,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { riseItem, staggerContainer } from "./motion";
import { useFleetPerformance } from "./use-fleet-performance";
import { HealthGauge, SectionCard, StatTile, healthTone } from "./widgets";

const SKELETON_TILES: readonly number[] = [0, 1, 2];

/** Solid bar colour per PHP bucket — green for current, amber for end-of-life. */
function phpBarColor(php: string): string {
  if (php === "unknown") return "bg-zinc-400";
  const match = php.match(/^(\d+)\.(\d+)/);
  if (!match) return "bg-zinc-400";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 8 || (major === 8 && minor >= 3)) return "bg-emerald-500";
  if (major === 8 && minor >= 1) return "bg-sky-500";
  return "bg-amber-500";
}

function PerformanceSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-3">
        {SKELETON_TILES.map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40"
          />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
    </div>
  );
}

function PerformanceErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
      <ServerCrash className="mx-auto h-6 w-6 text-red-500" aria-hidden />
      <p className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Couldn&apos;t load fleet performance</p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
      </button>
    </div>
  );
}

/** A Lighthouse score gauge, or a neutral dash placeholder when unmeasured. */
function ScoreGauge({ score, label }: { score: number | null; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      {score !== null ? (
        <HealthGauge score={score} size={92} strokeWidth={8} />
      ) : (
        <span className="grid h-[92px] w-[92px] place-items-center rounded-full border border-dashed border-zinc-300 text-lg text-zinc-400 dark:border-zinc-700">
          —
        </span>
      )}
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label === "Mobile" ? (
          <Smartphone className="h-4 w-4 text-zinc-400" aria-hidden />
        ) : (
          <Monitor className="h-4 w-4 text-zinc-400" aria-hidden />
        )}
        {label}
      </span>
    </div>
  );
}

function formatLcp(lcpMs: number | null): string {
  if (lcpMs === null) return "—";
  return `${(lcpMs / 1000).toFixed(2)} s`;
}

function formatCls(cls: number | null): string {
  if (cls === null) return "—";
  return cls.toFixed(2);
}

export function FleetPerformance() {
  const { data, loading, error, reload } = useFleetPerformance();

  if (error && !data) {
    return <PerformanceErrorCard message={error} onRetry={reload} />;
  }
  if (!data) {
    // Covers `loading && !data` (and the null-before-first-load case).
    return <PerformanceSkeleton />;
  }

  const { perf, pagespeed } = data;
  const maxBucket = perf.phpDistribution.reduce((max, bucket) => Math.max(max, bucket.count), 0);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Last-checked + refresh (real generatedAt from the perf roll-up) */}
      <motion.div
        variants={riseItem}
        className="flex items-center justify-end gap-2 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <span>Last checked {new Date(perf.generatedAt).toLocaleTimeString()}</span>
        <button
          type="button"
          onClick={reload}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} aria-hidden /> Refresh
        </button>
      </motion.div>

      {/* Real posture stat tiles */}
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Sites managed" value={perf.total} icon={Cpu} />
        <StatTile
          label="Fleet health (avg)"
          value={perf.healthAverage ?? 0}
          icon={HeartPulse}
          tone={healthTone(perf.healthAverage ?? 0)}
        />
        <StatTile
          label="PHP upgrade needed"
          value={perf.upgradeNeeded}
          icon={AlertTriangle}
          tone={perf.upgradeNeeded > 0 ? healthTone(40) : healthTone(95)}
        />
      </motion.div>

      {/* Real PHP-version distribution from the fleet rows */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="PHP version distribution"
          description="Live PHP runtime across every managed site — versions below 8.1 need an upgrade."
          icon={Cpu}
        >
          {perf.phpDistribution.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No managed sites yet.</p>
          ) : (
            <ul className="space-y-3">
              {perf.phpDistribution.map((bucket) => (
                <li key={bucket.php} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    PHP {bucket.php}
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className={cn("h-full rounded-full", phpBarColor(bucket.php))}
                      style={{ width: `${maxBucket > 0 ? (bucket.count / maxBucket) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-400">
                    {bucket.count} site{bucket.count === 1 ? "" : "s"}
                    {bucket.upgradeNeeded ? (
                      <span className="ml-1 font-medium text-amber-600 dark:text-amber-400">· upgrade</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </motion.div>

      {/* Google PageSpeed — real when configured, honestly degraded when not */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="PageSpeed (Lighthouse)"
          description="Google PageSpeed Insights performance scores and Core Web Vitals per site."
          icon={Gauge}
        >
          {!pagespeed.configured ? (
            <div className="flex items-start gap-3 rounded-xl border border-dashed border-amber-500/50 bg-amber-500/5 px-4 py-4 text-sm text-amber-800 dark:text-amber-200">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">PageSpeed is not configured</p>
                <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">
                  {pagespeed.reason ?? "PageSpeed needs PAGESPEED_API_KEY configured."}
                </p>
              </div>
            </div>
          ) : pagespeed.sites.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No managed sites to measure yet.</p>
          ) : (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
              {pagespeed.sites.map((site) => (
                <div
                  key={site.site}
                  className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{site.site}</p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{site.url}</p>
                  </div>

                  {site.error ? (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0">{site.error}</span>
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 flex items-center justify-around gap-3">
                        <ScoreGauge score={site.mobile} label="Mobile" />
                        <ScoreGauge score={site.desktop} label="Desktop" />
                      </div>
                      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                          <dt className="text-zinc-500 dark:text-zinc-400">LCP</dt>
                          <dd className="mt-0.5 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                            {formatLcp(site.lcpMs)}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                          <dt className="text-zinc-500 dark:text-zinc-400">CLS</dt>
                          <dd className="mt-0.5 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                            {formatCls(site.cls)}
                          </dd>
                        </div>
                      </dl>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </motion.div>

      <motion.div variants={riseItem} className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
        <Rocket className="h-3.5 w-3.5" aria-hidden />
        <span>PageSpeed scores are field/lab audits from Google Lighthouse and refresh at most every 10 minutes.</span>
      </motion.div>
    </motion.div>
  );
}
