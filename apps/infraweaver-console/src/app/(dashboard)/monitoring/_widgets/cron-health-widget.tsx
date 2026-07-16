"use client";

import type { CronJobItem } from "@/lib/ops-data";
import { cronOverdueLevel, isCronWedged, type Signal } from "@/lib/observability-signals";
import { SignalCard } from "./signal-card";

interface CronHealthWidgetProps {
  signal?: Signal;
  cronjobs: CronJobItem[];
  now: number;
  isLoading?: boolean;
  isError?: boolean;
}

function Pill({ label, value, tone }: { label: string; value: number; tone: "danger" | "warn" | "neutral" }) {
  const color = tone === "danger"
    ? "text-red-500"
    : tone === "warn"
      ? "text-amber-500"
      : "text-gray-900 dark:text-white";
  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-950/40 px-3 py-2 text-center">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-[#888]">{label}</p>
    </div>
  );
}

/** Cron overdue/wedged detector — the WP health-sweep silent-gap surface. */
export function CronHealthWidget({ signal, cronjobs, now, isLoading, isError }: CronHealthWidgetProps) {
  const wedged = cronjobs.filter((cron) => isCronWedged(cron, now));
  const overdue = cronjobs.filter((cron) => !isCronWedged(cron, now) && cronOverdueLevel(cron, now) !== "ok");
  const failing = cronjobs.filter((cron) => cron.failing);
  const offenders = [...wedged, ...overdue].slice(0, 3);

  return (
    <SignalCard source="cron" signal={signal} isLoading={isLoading} isError={isError}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Pill label="Wedged" value={wedged.length} tone={wedged.length > 0 ? "danger" : "neutral"} />
          <Pill label="Overdue" value={overdue.length} tone={overdue.length > 0 ? "warn" : "neutral"} />
          <Pill label="Failing" value={failing.length} tone={failing.length > 0 ? "warn" : "neutral"} />
        </div>
        {offenders.length > 0 ? (
          <ul className="space-y-1">
            {offenders.map((cron) => (
              <li key={cron.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-gray-700 dark:text-[#d4d4d4]">{cron.namespace}/{cron.name}</span>
                <span className="shrink-0 text-gray-500 dark:text-[#888]">{isCronWedged(cron, now) ? "wedged" : "overdue"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-500 dark:text-[#888]">{cronjobs.length} cronjobs on schedule</p>
        )}
      </div>
    </SignalCard>
  );
}
