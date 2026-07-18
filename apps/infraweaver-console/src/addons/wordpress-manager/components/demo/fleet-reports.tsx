"use client";

import { motion } from "framer-motion";
import {
  Camera,
  CheckCircle2,
  FileText,
  HardDriveDownload,
  History,
  LogIn,
  Rocket,
  ShieldCheck,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DummyBadge } from "./DummyBadge";
import { riseItem, staggerContainer } from "./motion";
import { AnimatedNumber, SectionCard } from "./widgets";
import { ACTIVITY_LOG, CLIENT_REPORT, SAFE_UPDATES, type ActivityKind } from "./dummy-data";

const KIND_ICON: Readonly<Record<ActivityKind, React.ElementType>> = {
  update: UploadCloud,
  backup: HardDriveDownload,
  security: ShieldCheck,
  login: LogIn,
  deploy: Rocket,
};

const KIND_TONE: Readonly<Record<ActivityKind, string>> = {
  update: "text-sky-500",
  backup: "text-emerald-500",
  security: "text-violet-500",
  login: "text-amber-500",
  deploy: "text-rose-500",
};

const RESULT_TONE = {
  pass: { badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", icon: CheckCircle2, label: "Passed" },
  fail: { badge: "bg-red-500/10 text-red-600 dark:text-red-400", icon: XCircle, label: "Failed" },
  review: { badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400", icon: Camera, label: "Needs review" },
} as const;

export function FleetReports() {
  const reportStats = [
    { label: "Visitors", value: CLIENT_REPORT.visitors, decimals: 0 },
    { label: "Uptime", value: CLIENT_REPORT.uptime, decimals: 2, suffix: "%" },
    { label: "Updates applied", value: CLIENT_REPORT.updatesApplied, decimals: 0 },
    { label: "Threats blocked", value: CLIENT_REPORT.threatsBlocked, decimals: 0 },
    { label: "Backups taken", value: CLIENT_REPORT.backupsTaken, decimals: 0 },
    { label: "Avg performance", value: CLIENT_REPORT.avgPerformance, decimals: 0, suffix: "/100" },
  ] as const;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* White-label client report preview */}
      <motion.div variants={riseItem}>
        <SectionCard title="Client report" description="Shareable white-label monthly summary — a client's-eye view of the work done." icon={FileText} action={<DummyBadge label="Demo preview" />}>
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950/50">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sm font-bold text-sky-600 dark:text-sky-400">IW</span>
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Monthly care report</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{CLIENT_REPORT.period} · prepared by InfraWeaver</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> All systems healthy
              </span>
            </div>
            <div className="grid gap-px bg-zinc-200 dark:bg-zinc-800 sm:grid-cols-3">
              {reportStats.map((stat) => (
                <div key={stat.label} className="bg-white p-4 dark:bg-zinc-900/60">
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{stat.label}</p>
                  <AnimatedNumber
                    value={stat.value}
                    decimals={stat.decimals}
                    suffix={"suffix" in stat ? stat.suffix : undefined}
                    className="mt-1 block text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
                  />
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* Safe / smart updates */}
        <motion.div variants={riseItem}>
          <SectionCard title="Safe updates" description="Visual regression check runs before every update is committed." icon={Camera} action={<DummyBadge />}>
            <ul className="space-y-3">
              {SAFE_UPDATES.map((check) => {
                const tone = RESULT_TONE[check.result];
                const ResultIcon = tone.icon;
                return (
                  <li key={check.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{check.component}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{check.site}</p>
                      </div>
                      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tone.badge)}>
                        <ResultIcon className="h-3.5 w-3.5" aria-hidden /> {tone.label}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {(["Before", "After"] as const).map((side) => (
                        <div key={side} className="relative aspect-[16/9] overflow-hidden rounded-lg border border-zinc-200 bg-gradient-to-br from-zinc-100 to-zinc-200 dark:border-zinc-800 dark:from-zinc-800/60 dark:to-zinc-900">
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Camera className="h-5 w-5 text-zinc-400 dark:text-zinc-600" aria-hidden />
                          </div>
                          <span className="absolute left-1.5 top-1.5 rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white">{side}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Visual difference: <span className="font-medium text-zinc-700 dark:text-zinc-300">{check.visualDiff}%</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </motion.div>

        {/* Activity / audit log */}
        <motion.div variants={riseItem}>
          <SectionCard title="Activity log" description="Recent automated and human actions across the fleet." icon={History} action={<DummyBadge />}>
            <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-zinc-200 dark:before:bg-zinc-800">
              {ACTIVITY_LOG.map((item) => {
                const Icon = KIND_ICON[item.kind];
                return (
                  <li key={item.id} className="relative flex gap-3">
                    <span className="z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-full border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                      <Icon className={cn("h-4 w-4", KIND_TONE[item.kind])} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1 pt-1">
                      <p className="text-sm text-zinc-900 dark:text-zinc-100">
                        <span className="font-medium">{item.action}</span>
                      </p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">{item.target}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-500">{item.actor} · {item.when}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </SectionCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
