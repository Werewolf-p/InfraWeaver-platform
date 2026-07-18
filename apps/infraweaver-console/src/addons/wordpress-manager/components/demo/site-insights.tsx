"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Activity, Clock, Database, Gauge, Rocket, ShieldAlert, Timer, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { DemoBanner, DummyBadge } from "./DummyBadge";
import { EASE_OUT } from "./motion";
import {
  AnimatedNumber,
  HealthGauge,
  MiniGauge,
  SectionCard,
  SeverityBadge,
  StatTile,
  STATUS_LABEL,
  STATUS_TONE,
  UptimeStrip,
  healthTone,
} from "./widgets";
import { BackupAreaChart, PhpErrorLine, ResponseTimeLine, WafAreaChart } from "./charts";
import {
  BACKUP_TREND,
  CORE_WEB_VITALS,
  DEMO_SITES,
  PAGESPEED,
  PHP_TREND,
  RESPONSE_TREND,
  UPTIME_90,
  VULNERABILITIES,
  WAF_TREND,
  type DemoSite,
} from "./dummy-data";

type SiteTab = "monitoring" | "security" | "performance";

const SITE_TABS: ReadonlyArray<{ id: SiteTab; label: string; icon: React.ElementType }> = [
  { id: "monitoring", label: "Monitoring", icon: Activity },
  { id: "security", label: "Security", icon: ShieldAlert },
  { id: "performance", label: "Performance", icon: Gauge },
];

/** Deterministic demo-site pick from the real site name (no randomness → SSR-safe). */
function pickDemoSite(name: string): DemoSite {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return DEMO_SITES[hash % DEMO_SITES.length];
}

export function SiteDemoInsights({ site }: { site: string }) {
  const [tab, setTab] = useState<SiteTab>("monitoring");
  const demo = useMemo(() => pickDemoSite(site), [site]);
  const tone = STATUS_TONE[demo.status];

  return (
    <MotionConfig reducedMotion="user">
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
            <Rocket className="h-5 w-5 text-sky-500" aria-hidden />
            <h2 className="text-lg font-medium">Site insights</h2>
            <DummyBadge />
          </div>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", tone.ring, tone.soft, tone.text)}>
            {STATUS_LABEL[demo.status]}
          </span>
        </div>

        <DemoBanner className="mt-4" />

        {/* At-a-glance summary */}
        <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr]">
          <div className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
            <HealthGauge score={demo.health} size={112} strokeWidth={10} label="health" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Uptime (30d)" value={demo.status === "offline" ? 0 : demo.uptime} decimals={2} suffix="%" icon={Gauge} tone={healthTone(demo.health)} />
            <StatTile label="Response" value={demo.responseMs} suffix="ms" icon={Timer} tone={healthTone(demo.responseMs < 300 ? 92 : demo.responseMs < 600 ? 70 : 40)} />
            <StatTile label="Visitors (7d)" value={demo.visitors7d} icon={Users} tone={healthTone(82)} spark={demo.spark} />
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="mt-5 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
          {SITE_TABS.map((entry) => {
            const on = entry.id === tab;
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                aria-pressed={on}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-sm transition-colors",
                  on
                    ? "border-sky-500 font-medium text-zinc-900 dark:text-zinc-100"
                    : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {entry.label}
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="mt-5"
          >
            {tab === "monitoring" && (
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="lg:col-span-2">
                  <div className="mb-2 flex items-baseline justify-between">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">90-day uptime</p>
                    <AnimatedNumber value={demo.status === "offline" ? 97.12 : demo.uptime} decimals={2} suffix="%" className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <UptimeStrip days={UPTIME_90} />
                </div>
                <SectionCard title="Response time" description="Origin latency, last 24 hours." icon={Clock} action={<DummyBadge />}>
                  <ResponseTimeLine data={RESPONSE_TREND} />
                </SectionCard>
                <SectionCard title="Backups" description="Nightly backup size trend." icon={Database} action={<DummyBadge />}>
                  <div className="mb-2 flex items-baseline gap-2">
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">Last backup</span>
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{demo.lastBackup}</span>
                  </div>
                  <BackupAreaChart data={BACKUP_TREND} />
                </SectionCard>
              </div>
            )}

            {tab === "security" && (
              <div className="grid gap-5 lg:grid-cols-2">
                <SectionCard title="Firewall activity" description="Blocked requests over 24 hours." icon={ShieldAlert} action={<DummyBadge />}>
                  <WafAreaChart data={WAF_TREND} />
                </SectionCard>
                <SectionCard title="Component advisories" description="Open CVEs affecting this site's stack." icon={ShieldAlert} action={<DummyBadge />}>
                  <ul className="space-y-2">
                    {VULNERABILITIES.slice(0, 4).map((v) => (
                      <li key={v.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{v.component}</p>
                          <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{v.cve}</p>
                        </div>
                        <SeverityBadge severity={v.severity} />
                      </li>
                    ))}
                  </ul>
                </SectionCard>
              </div>
            )}

            {tab === "performance" && (
              <div className="grid gap-5 lg:grid-cols-2">
                <SectionCard title="PageSpeed" description="Lighthouse score, mobile vs desktop." icon={Gauge} action={<DummyBadge />}>
                  <div className="flex items-center justify-around">
                    <div className="flex flex-col items-center gap-2">
                      <HealthGauge score={PAGESPEED.mobile} size={92} strokeWidth={8} />
                      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Mobile</span>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                      <HealthGauge score={PAGESPEED.desktop} size={92} strokeWidth={8} />
                      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Desktop</span>
                    </div>
                  </div>
                </SectionCard>
                <SectionCard title="Core Web Vitals" description="Field metrics, last 28 days." icon={Rocket} action={<DummyBadge />}>
                  <div className="grid grid-cols-3 gap-3">
                    {CORE_WEB_VITALS.map((cwv) => (
                      <MiniGauge key={cwv.label} score={cwv.score} caption={cwv.label} unit={cwv.value} />
                    ))}
                  </div>
                </SectionCard>
                <div className="lg:col-span-2">
                  <SectionCard title="PHP error rate" description="Runtime errors over 24 hours." icon={Rocket} action={<DummyBadge />}>
                    <PhpErrorLine data={PHP_TREND} />
                  </SectionCard>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </section>
    </MotionConfig>
  );
}
