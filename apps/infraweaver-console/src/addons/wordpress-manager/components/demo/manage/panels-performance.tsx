"use client";

// Performance tab for the per-site "Manage" demo console — PageSpeed, CWV, caching, PHP errors.
import { Bug, Clock, Gauge, LineChart, Rocket, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageData } from "../site-manage-data";
import { AnimatedNumber, HealthGauge, MiniGauge, SectionCard, healthTone } from "../widgets";
import { PageSpeedTrend, ResponseTimeLine } from "../charts";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const NEUTRAL = "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";
const LEVEL_TONE = {
  fatal: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  notice: NEUTRAL,
} as const;
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");

export function PerformancePanel({ data }: { data: SiteManageData; site: string }) {
  const { pagespeed, cwv, perfTrend, responseTrend, cache, phpErrors } = data;
  const cacheTone = healthTone(cache.hitRate);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="PageSpeed" description="Lighthouse score, mobile vs desktop." icon={Gauge} action={<DummyBadge />}>
        <div className="flex items-center justify-around">
          <div className="flex flex-col items-center gap-2">
            <HealthGauge score={pagespeed.mobile} size={92} strokeWidth={8} />
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Mobile</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <HealthGauge score={pagespeed.desktop} size={92} strokeWidth={8} />
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Desktop</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Core Web Vitals" description="Field metrics, last 28 days." icon={Rocket} action={<DummyBadge />}>
        <div className="grid grid-cols-3 gap-3">
          {cwv.map((v) => (
            <MiniGauge key={v.label} score={v.score} caption={v.label} unit={v.value} />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="PageSpeed trend"
        description="Lighthouse score over the last 14 days."
        icon={LineChart}
        action={<DummyBadge />}
      >
        <PageSpeedTrend data={perfTrend} />
      </SectionCard>

      <SectionCard title="Response time" description="Origin latency, last 24 hours." icon={Clock} action={<DummyBadge />}>
        <ResponseTimeLine data={responseTrend} />
      </SectionCard>

      <SectionCard title="Caching & CDN" description="Edge cache and delivery network." icon={Zap} action={<DummyBadge />}>
        <div className="flex flex-col items-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
          <AnimatedNumber value={cache.hitRate} suffix="%" className={cn("text-4xl font-semibold tabular-nums", cacheTone.text)} />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">cache hit rate</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Engine</span>
          <span className={cn(PILL, NEUTRAL)}>{cache.engine}</span>
          <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">CDN</span>
          <span className={cn(PILL, NEUTRAL)}>{cache.cdn}</span>
        </div>
        <button type="button" onClick={demo} className={cn(BTN, "mt-3 w-full justify-center")}>
          <Zap className="h-4 w-4" aria-hidden /> Purge cache
        </button>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="PHP errors"
        description="Most frequent runtime errors, last 24 hours."
        icon={Bug}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Message</th>
                <th className="py-2 pr-4 font-medium">Level</th>
                <th className="py-2 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {phpErrors.map((e, i) => (
                <tr key={i} className="text-zinc-700 dark:text-zinc-300">
                  <td className="max-w-0 py-2 pr-4">
                    <span className="block min-w-0 truncate font-mono text-[11px]">{e.message}</span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL, "capitalize", LEVEL_TONE[e.level])}>{e.level}</span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{e.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
