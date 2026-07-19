"use client";

// Logs panel — the tail of the WordPress debug log, read live from the pod and
// parsed into level-tagged entries. Read-only; informative empty state when
// WP_DEBUG_LOG is off.
import { useState } from "react";
import { Bug, FileWarning, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LogEntry, LogLevel, LogsData } from "../../../lib/manage/probes/logs";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";

const LEVEL_TONE: Readonly<Record<LogLevel, string>> = {
  "Fatal error": "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  Error: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  Warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Notice: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  Deprecated: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  Other: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};

const LEVELS: readonly LogLevel[] = ["Fatal error", "Error", "Warning", "Notice", "Deprecated", "Other"];

function DebugOff({ logPath }: { logPath: string | null }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      <FileWarning className="h-6 w-6 text-amber-500" aria-hidden />
      <p className="max-w-prose">
        WP_DEBUG_LOG is off — enable it in <code className="font-mono">wp-config.php</code> to collect logs.
      </p>
      {logPath ? <p className="font-mono text-[11px] text-zinc-400">{logPath}</p> : null}
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <span className={cn(PILL, LEVEL_TONE[entry.level], "shrink-0")}>{entry.level}</span>
      <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
        {entry.message}
      </span>
      {entry.at ? <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{entry.at}</span> : null}
    </li>
  );
}

export function LogsPanel({ site }: { site: string }) {
  const state = useManagePanel<LogsData>(site, "logs");
  const [filter, setFilter] = useState<LogLevel | "All">("All");

  return (
    <PanelState state={state}>
      {(data) => {
        if (!data.debugLogEnabled) {
          return (
            <SectionCard title="Debug log" description="PHP/WordPress errors captured on the pod." icon={ScrollText}>
              <DebugOff logPath={data.logPath} />
            </SectionCard>
          );
        }

        const errorish = data.counts["Fatal error"] + data.counts.Error;
        const visible = filter === "All" ? data.entries : data.entries.filter((e) => e.level === filter);

        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
              <StatTile label="Entries" value={data.entries.length} icon={ScrollText} tone={healthTone(80)} />
              <StatTile
                label="Errors + fatals"
                value={errorish}
                icon={Bug}
                tone={healthTone(errorish === 0 ? 96 : errorish < 5 ? 60 : 28)}
              />
              <StatTile
                label="Warnings"
                value={data.counts.Warning}
                icon={FileWarning}
                tone={healthTone(data.counts.Warning === 0 ? 96 : 62)}
              />
            </div>

            <SectionCard
              className="lg:col-span-2"
              title="Recent entries"
              description={data.logPath ? `Tail of ${data.logPath}.` : "Most recent debug-log lines."}
              icon={ScrollText}
              action={
                <div className="inline-flex flex-wrap gap-1" role="group" aria-label="Filter by level">
                  {(["All", ...LEVELS] as const).map((level) => {
                    const active = filter === level;
                    const count = level === "All" ? data.entries.length : data.counts[level];
                    return (
                      <button
                        key={level}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setFilter(level)}
                        className={cn(
                          "rounded-lg border px-2 py-1 text-xs font-medium transition-colors",
                          active
                            ? "border-sky-500 bg-sky-500 text-white"
                            : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
                        )}
                      >
                        {level} {count > 0 ? <span className="tabular-nums opacity-70">({count})</span> : null}
                      </button>
                    );
                  })}
                </div>
              }
            >
              {visible.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  {data.entries.length === 0 ? "No recent log entries." : `No ${filter} entries in this window.`}
                </div>
              ) : (
                <ul className="space-y-2">
                  {visible.map((entry, i) => (
                    <LogRow key={`${entry.level}-${i}`} entry={entry} />
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
