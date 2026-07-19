"use client";

// Access & error logs tab for the per-site "Manage" demo console.
import { useState, type ReactNode } from "react";
import { Bug, Download, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { AccessLogRow, ErrorLogRow, SiteManageExt } from "../site-manage-ext-data";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const demo = () => toast.info("Demo — no changes are made to the live site.");

type PillTone = "info" | "warn" | "critical" | "neutral";
const PILL_TONE: Readonly<Record<PillTone, string>> = {
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", PILL_TONE[tone])}>
      {children}
    </span>
  );
}

const METHOD_TONE: Readonly<Record<AccessLogRow["method"], PillTone>> = { GET: "neutral", POST: "info", HEAD: "neutral" };
const LEVEL_TONE: Readonly<Record<ErrorLogRow["level"], PillTone>> = { error: "critical", warning: "warn", notice: "neutral" };
const METHODS = ["All", "GET", "POST", "HEAD"] as const;
type MethodFilter = (typeof METHODS)[number];

function statusColor(status: number): string {
  if (status < 300) return "text-emerald-600 dark:text-emerald-400";
  if (status < 400) return "text-sky-600 dark:text-sky-400";
  if (status < 500) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function LogsPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { requests24h, errors24h, access, errors } = ext.logs;
  const [filter, setFilter] = useState<MethodFilter>("All");
  const visible = filter === "All" ? access : access.filter((r) => r.method === filter);
  const errTone = healthTone(errors24h === 0 ? 100 : errors24h < 20 ? 82 : errors24h < 80 ? 55 : 28);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
        <StatTile label="Requests (24h)" value={requests24h} icon={ScrollText} />
        <StatTile label="Errors (24h)" value={errors24h} icon={Bug} tone={errTone} />
      </div>

      <SectionCard
        className="lg:col-span-2"
        title="Access log"
        description="Recent HTTP requests served."
        icon={ScrollText}
        action={
          <div className="flex items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700" role="group" aria-label="Filter by method">
              {METHODS.map((m) => {
                const active = filter === m;
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(m)}
                    className={cn(
                      "px-2.5 py-1 text-xs font-medium transition-colors",
                      active
                        ? "bg-sky-500 text-white"
                        : "bg-white text-zinc-600 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
                    )}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
            <DummyBadge />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Method</th>
                <th className="py-2 pr-4 font-medium">Path</th>
                <th className="py-2 pr-4 text-right font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">IP</th>
                <th className="py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    No {filter} requests in this window.
                  </td>
                </tr>
              ) : (
                visible.map((row, i) => (
                  <tr key={`${row.method}-${row.path}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                    <td className="py-2 pr-4">
                      <Pill tone={METHOD_TONE[row.method]}>{row.method}</Pill>
                    </td>
                    <td className="py-2 pr-4 font-mono text-[11px]">{row.path}</td>
                    <td className={cn("py-2 pr-4 text-right font-medium tabular-nums", statusColor(row.status))}>{row.status}</td>
                    <td className="py-2 pr-4 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{row.ip}</td>
                    <td className="py-2 text-zinc-500 dark:text-zinc-400">{row.when}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Error log"
        description="PHP notices, warnings and fatals."
        icon={Bug}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={demo}>
              <Download className="h-3.5 w-3.5" aria-hidden /> Download log
            </button>
            <DummyBadge />
          </div>
        }
      >
        {errors.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No errors logged in this window.
          </div>
        ) : (
          <ul className="space-y-2">
            {errors.map((e, i) => (
              <li key={`${e.level}-${i}`} className={cn(TILE, "flex items-center gap-3")}>
                <Pill tone={LEVEL_TONE[e.level]}>{e.level}</Pill>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{e.message}</span>
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{e.when}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
