"use client";

import { motion } from "framer-motion";
import { Activity, CalendarClock, Clock, Database, Gauge, HardDriveDownload, Timer, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { DummyBadge } from "./DummyBadge";
import { riseItem, staggerContainer } from "./motion";
import { AnimatedNumber, SectionCard, StatTile, UptimeStrip, healthTone } from "./widgets";
import { BackupAreaChart, ResponseTimeLine, TrafficArea } from "./charts";
import {
  BACKUP_TREND,
  DEMO_SITES,
  FLEET_SUMMARY,
  RESPONSE_TREND,
  RESTORE_POINTS,
  TOP_PAGES,
  TRAFFIC_TREND,
  UPTIME_90,
} from "./dummy-data";

function sslTone(days: number): string {
  if (days <= 7) return "text-red-600 dark:text-red-400";
  if (days <= 30) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

export function FleetMonitoring() {
  const trafficTotal = TRAFFIC_TREND.reduce((n, p) => n + p.visitors, 0);
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Fleet uptime (30d)" value={FLEET_SUMMARY.avgUptime} decimals={2} suffix="%" icon={Gauge} tone={healthTone(96)} delta={0.03} />
        <StatTile label="Avg response" value={FLEET_SUMMARY.avgResponse} suffix="ms" icon={Timer} tone={healthTone(80)} delta={-6} positiveIsGood />
        <StatTile label="Backups healthy" value={FLEET_SUMMARY.backupsHealthy} suffix={`/${FLEET_SUMMARY.total}`} icon={HardDriveDownload} tone={healthTone(92)} />
        <StatTile label="Visitors (7d)" value={trafficTotal} icon={Users} tone={healthTone(85)} delta={9} />
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-2">
        <motion.div variants={riseItem}>
          <SectionCard
            title="Uptime monitor"
            description="Per-day status over the last 90 days — green up, amber degraded, red down."
            icon={Activity}
            action={<DummyBadge />}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <AnimatedNumber value={99.98} decimals={2} suffix="%" className="text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400" />
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">90-day availability</p>
              </div>
              <div className="flex gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500/80" aria-hidden /> Up</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-500/90" aria-hidden /> Degraded</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-red-500/90" aria-hidden /> Down</span>
              </div>
            </div>
            <div className="mt-4">
              <UptimeStrip days={UPTIME_90} />
            </div>
          </SectionCard>
        </motion.div>

        <motion.div variants={riseItem}>
          <SectionCard title="Response time" description="Median origin response across the fleet, last 24 hours." icon={Clock} action={<DummyBadge />}>
            <ResponseTimeLine data={RESPONSE_TREND} />
          </SectionCard>
        </motion.div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <motion.div variants={riseItem}>
          <SectionCard title="Backups" description="Nightly backup size trend with recent restore points." icon={Database} action={<DummyBadge />}>
            <div className="mb-3 flex items-baseline gap-2">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Last backup</span>
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">18m ago</span>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">Verified</span>
            </div>
            <BackupAreaChart data={BACKUP_TREND} />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[360px] text-left text-sm">
                <thead>
                  <tr className="text-xs text-zinc-500 dark:text-zinc-400">
                    <th className="pb-2 font-medium">Restore point</th>
                    <th className="pb-2 font-medium">Size</th>
                    <th className="pb-2 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {RESTORE_POINTS.map((rp) => (
                    <tr key={rp.id} className="text-zinc-800 dark:text-zinc-200">
                      <td className="py-2">{rp.when}</td>
                      <td className="py-2 tabular-nums">{rp.size}</td>
                      <td className="py-2">
                        <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] capitalize text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">{rp.type}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </motion.div>

        <motion.div variants={riseItem}>
          <SectionCard title="Traffic analytics" description="Fleet-wide visitors this week and the busiest pages." icon={Users} action={<DummyBadge />}>
            <TrafficArea data={TRAFFIC_TREND} />
            <ul className="mt-4 space-y-1.5">
              {TOP_PAGES.map((page) => (
                <li key={page.path} className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">{page.path}</span>
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{page.site}</span>
                  <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{page.views.toLocaleString("en-US")}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </motion.div>
      </div>

      <motion.div variants={riseItem}>
        <SectionCard title="SSL & domain expiry" description="Certificate and domain renewal countdowns per site." icon={CalendarClock} action={<DummyBadge />}>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
            {DEMO_SITES.map((site) => (
              <div key={site.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{site.name}</p>
                <p className={cn("mt-2 text-lg font-semibold tabular-nums", sslTone(site.sslDaysLeft))}>
                  {site.sslDaysLeft}
                  <span className="ml-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">days left</span>
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </motion.div>
    </motion.div>
  );
}
