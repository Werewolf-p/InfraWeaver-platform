"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Layers,
  ServerCrash,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DummyBadge } from "./DummyBadge";
import { riseItem, staggerContainer } from "./motion";
import {
  AnimatedNumber,
  HealthGauge,
  SectionCard,
  Sparkline,
  StatTile,
  STATUS_LABEL,
  STATUS_TONE,
  healthTone,
} from "./widgets";
import { UpdatesStackedBar } from "./charts";
import { ATTENTION_FEED, DEMO_SITES, FLEET_SUMMARY, UPDATES_TREND } from "./dummy-data";
import { SeverityBadge } from "./widgets";

export function FleetOverview() {
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Fleet stat tiles */}
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Sites managed" value={FLEET_SUMMARY.total} icon={Layers} />
        <StatTile label="Healthy" value={FLEET_SUMMARY.healthy} icon={CheckCircle2} tone={STATUS_TONE.healthy} delta={2} />
        <StatTile
          label="Need attention"
          value={FLEET_SUMMARY.attention + FLEET_SUMMARY.critical}
          icon={AlertTriangle}
          tone={STATUS_TONE.attention}
          delta={1}
          positiveIsGood={false}
        />
        <StatTile label="Updates pending" value={FLEET_SUMMARY.updatesPending} icon={ArrowUpCircle} tone={healthTone(60)} delta={-14} positiveIsGood={false} />
      </motion.div>

      {/* All-sites health grid */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="All-sites health"
          description="Composite health score, live trend and pending work for every managed site."
          icon={Gauge}
          action={<DummyBadge />}
        >
          <motion.ul
            variants={staggerContainer}
            initial="hidden"
            animate="show"
            className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]"
          >
            {DEMO_SITES.map((site) => {
              const tone = STATUS_TONE[site.status];
              const pending = site.updates.core + site.updates.plugins + site.updates.themes;
              return (
                <motion.li
                  key={site.id}
                  variants={riseItem}
                  className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{site.name}</p>
                      <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {site.url} <ExternalLink className="h-3 w-3" aria-hidden />
                      </span>
                    </div>
                    <HealthGauge score={site.health} size={56} strokeWidth={6} />
                  </div>

                  <Sparkline data={site.spark} stroke={tone.stroke} width={220} height={30} />

                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", tone.ring, tone.soft, tone.text)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", tone.text.includes("emerald") ? "bg-emerald-500" : tone.text.includes("amber") ? "bg-amber-500" : tone.text.includes("red") ? "bg-red-500" : "bg-zinc-400")} aria-hidden />
                      {STATUS_LABEL[site.status]}
                    </span>
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {site.status === "offline" ? "—" : `${site.uptime}%`} · {pending} update{pending === 1 ? "" : "s"}
                    </span>
                  </div>
                </motion.li>
              );
            })}
          </motion.ul>
        </SectionCard>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* Pending updates */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Pending updates"
            description="Core, plugin and theme updates awaiting rollout across the fleet, by week."
            icon={ArrowUpCircle}
            action={<DummyBadge />}
          >
            <div className="mb-4 grid grid-cols-3 gap-3">
              {(
                [
                  { label: "Core", key: "core", color: "bg-sky-500" },
                  { label: "Plugins", key: "plugins", color: "bg-violet-500" },
                  { label: "Themes", key: "themes", color: "bg-amber-500" },
                ] as const
              ).map((row) => {
                const total = DEMO_SITES.reduce((n, s) => n + s.updates[row.key], 0);
                return (
                  <div key={row.key} className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                    <span className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                      <span className={cn("h-2 w-2 rounded-full", row.color)} aria-hidden />
                      {row.label}
                    </span>
                    <AnimatedNumber value={total} className="mt-1 block text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100" />
                  </div>
                );
              })}
            </div>
            <UpdatesStackedBar data={UPDATES_TREND} />
          </SectionCard>
        </motion.div>

        {/* Global attention feed */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Attention feed"
            description="Prioritised actions across every site, most urgent first."
            icon={ShieldAlert}
            action={<DummyBadge />}
          >
            <ul className="space-y-2">
              {ATTENTION_FEED.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40"
                >
                  <span className="mt-0.5">
                    {item.severity === "critical" ? (
                      <ServerCrash className="h-4 w-4 text-red-500" aria-hidden />
                    ) : (
                      <AlertTriangle className={cn("h-4 w-4", item.severity === "high" ? "text-orange-500" : item.severity === "medium" ? "text-amber-500" : "text-sky-500")} aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-900 dark:text-zinc-100">{item.title}</p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {item.site} · {item.when}
                    </p>
                  </div>
                  <SeverityBadge severity={item.severity} />
                </li>
              ))}
            </ul>
          </SectionCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
