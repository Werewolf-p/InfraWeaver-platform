"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Bug, Gauge, ListChecks, Rocket, Smartphone, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { DummyBadge } from "./DummyBadge";
import { riseItem, staggerContainer } from "./motion";
import { HealthGauge, MiniGauge, ProgressRing, SectionCard, healthTone } from "./widgets";
import { PageSpeedTrend, PhpErrorLine } from "./charts";
import { BULK_UPDATES, CORE_WEB_VITALS, PAGESPEED, PERF_TREND, PHP_ERRORS, PHP_TREND } from "./dummy-data";

const PHP_LEVEL_TONE = {
  fatal: "bg-red-500/10 text-red-600 dark:text-red-400",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  notice: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
} as const;

const BULK_STATE_TONE = {
  queued: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  running: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400",
} as const;

function bulkTone(progress: number, failed: boolean) {
  if (failed) return healthTone(30);
  if (progress >= 100) return healthTone(95);
  return healthTone(72);
}

export function FleetPerformance() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(["b3", "b4"]));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <motion.div variants={riseItem}>
          <SectionCard title="PageSpeed" description="Lighthouse performance score, mobile vs desktop." icon={Gauge} action={<DummyBadge />}>
            <div className="flex items-center justify-around gap-4">
              <div className="flex flex-col items-center gap-2">
                <HealthGauge score={PAGESPEED.mobile} size={104} strokeWidth={9} />
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  <Smartphone className="h-4 w-4 text-zinc-400" aria-hidden /> Mobile
                </span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <HealthGauge score={PAGESPEED.desktop} size={104} strokeWidth={9} />
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  <Monitor className="h-4 w-4 text-zinc-400" aria-hidden /> Desktop
                </span>
              </div>
            </div>
            <div className="mt-4">
              <PageSpeedTrend data={PERF_TREND} />
            </div>
          </SectionCard>
        </motion.div>

        <motion.div variants={riseItem}>
          <SectionCard title="Core Web Vitals" description="Field metrics from the last 28 days of real-user monitoring." icon={Rocket} action={<DummyBadge />}>
            <div className="grid grid-cols-3 gap-3">
              {CORE_WEB_VITALS.map((cwv) => (
                <MiniGauge key={cwv.label} score={cwv.score} caption={cwv.label} unit={cwv.value} />
              ))}
            </div>
            <ul className="mt-4 space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
              {CORE_WEB_VITALS.map((cwv) => (
                <li key={cwv.label} className="flex items-center justify-between">
                  <span>{cwv.full}</span>
                  <span className={cn("rounded-full px-2 py-0.5 font-medium capitalize", cwv.rating === "good" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : cwv.rating === "needs-improvement" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-red-500/10 text-red-600 dark:text-red-400")}>
                    {cwv.rating.replace("-", " ")}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </motion.div>
      </div>

      <motion.div variants={riseItem}>
        <SectionCard title="PHP error monitoring" description="Runtime error rate over 24 hours with the noisiest sources." icon={Bug} action={<DummyBadge />}>
          <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
            <PhpErrorLine data={PHP_TREND} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[360px] text-left text-sm">
                <thead>
                  <tr className="text-xs text-zinc-500 dark:text-zinc-400">
                    <th className="pb-2 font-medium">Message</th>
                    <th className="pb-2 font-medium">Level</th>
                    <th className="pb-2 text-right font-medium">Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {PHP_ERRORS.map((err) => (
                    <tr key={err.id} className="text-zinc-800 dark:text-zinc-200">
                      <td className="max-w-[280px] py-2.5">
                        <span className="block truncate font-mono text-xs">{err.message}</span>
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{err.site}</span>
                      </td>
                      <td className="py-2.5">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", PHP_LEVEL_TONE[err.level])}>{err.level}</span>
                      </td>
                      <td className="py-2.5 text-right font-semibold tabular-nums">{err.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </SectionCard>
      </motion.div>

      <motion.div variants={riseItem}>
        <SectionCard
          title="Bulk update runner"
          description="Queue and track component updates across the fleet in one pass."
          icon={ListChecks}
          action={
            <div className="flex items-center gap-2">
              <DummyBadge />
              <button
                type="button"
                disabled={selected.size === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Rocket className="h-3.5 w-3.5" aria-hidden /> Run {selected.size}
              </button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 dark:text-zinc-400">
                  <th className="w-8 pb-2" />
                  <th className="pb-2 font-medium">Site</th>
                  <th className="pb-2 font-medium">Component</th>
                  <th className="pb-2 font-medium">Version</th>
                  <th className="pb-2 font-medium">Progress</th>
                  <th className="pb-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {BULK_UPDATES.map((row) => (
                  <tr key={row.id} className="text-zinc-800 dark:text-zinc-200">
                    <td className="py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        aria-label={`Select ${row.component} on ${row.site}`}
                        className="h-4 w-4 rounded border-zinc-300 text-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 dark:border-zinc-600 dark:bg-zinc-950"
                      />
                    </td>
                    <td className="py-2.5 text-xs">{row.site}</td>
                    <td className="py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{row.component}</td>
                    <td className="py-2.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.from} → {row.to}</td>
                    <td className="py-2.5"><ProgressRing value={row.progress} tone={bulkTone(row.progress, row.state === "failed")} /></td>
                    <td className="py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", BULK_STATE_TONE[row.state])}>{row.state}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </motion.div>
    </motion.div>
  );
}
