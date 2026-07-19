"use client";
// Updates panel — WordPress core, update activity trend and available updates (demo, fake data).

import { useState } from "react";
import { ArrowUpCircle, BarChart3, CheckCircle2, RefreshCw, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageData } from "../site-manage-data";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { UpdatesStackedBar } from "../charts";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-white";

const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  red: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

type RowKind = "security" | "feature" | "minor" | "theme";
interface UpdateRow {
  readonly key: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly kind: RowKind;
  readonly vulnerable: boolean;
}

const KIND_BADGE: Readonly<Record<RowKind, { label: string; tone: keyof typeof TONE_PILL }>> = {
  security: { label: "Security", tone: "red" },
  feature: { label: "Feature", tone: "sky" },
  minor: { label: "Minor", tone: "neutral" },
  theme: { label: "Theme", tone: "neutral" },
};

export function UpdatesPanel({ data, site }: { data: SiteManageData; site: string }) {
  const rows: UpdateRow[] = [
    ...data.plugins
      .filter((p) => p.updateType !== null)
      .map<UpdateRow>((p) => ({
        key: `plugin:${p.slug}`,
        name: p.name,
        from: p.version,
        to: p.latest,
        kind: p.updateType as RowKind,
        vulnerable: p.vulnerable,
      })),
    ...data.themes
      .filter((t) => t.updateAvailable)
      .map<UpdateRow>((t) => ({ key: `theme:${t.slug}`, name: t.name, from: t.version, to: t.latest, kind: "theme", vulnerable: false })),
  ];

  const securityCount = data.plugins.filter((p) => p.updateType === "security").length;
  const autoCount = data.plugins.filter((p) => p.autoUpdate).length;

  const [autoMinor, setAutoMinor] = useState(data.core.autoUpdateMinor);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
        <StatTile label="Pending" value={rows.length} icon={ArrowUpCircle} tone={healthTone(rows.length === 0 ? 96 : rows.length < 4 ? 74 : 46)} />
        <StatTile label="Security updates" value={securityCount} icon={ShieldAlert} tone={healthTone(securityCount === 0 ? 96 : securityCount < 2 ? 60 : 40)} />
        <StatTile label="Auto-update on" value={autoCount} icon={Zap} tone={healthTone(autoCount > 0 ? 90 : 55)} />
      </div>

      <SectionCard title="WordPress core" description={`Release channel for ${site}.`} icon={RefreshCw} action={<DummyBadge />}>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Version</p>
              <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {data.core.current} <span aria-hidden>→</span> {data.core.latest}
              </p>
            </div>
            {data.core.upToDate ? (
              <span className={cn(PILL, TONE_PILL.good)}>
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Up to date
              </span>
            ) : (
              <button type="button" className={BTN_PRIMARY} onClick={() => toast.success("Demo — core would update to " + data.core.latest + ".")}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Update core
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">PHP runtime</p>
              <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">PHP {data.core.php}</p>
            </div>
            <button
              type="button"
              aria-pressed={autoMinor}
              onClick={() => {
                setAutoMinor((v) => !v);
                toast.info(autoMinor ? "Demo — minor auto-updates paused." : "Demo — minor auto-updates enabled.");
              }}
              className={cn(PILL, "cursor-pointer transition-colors", autoMinor ? TONE_PILL.good : TONE_PILL.neutral)}
            >
              <Zap className="h-3.5 w-3.5" aria-hidden /> Auto-update minor {autoMinor ? "on" : "off"}
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Update activity" description="Updates applied per week." icon={BarChart3} action={<DummyBadge />}>
        <UpdatesStackedBar data={data.updatesTrend} />
      </SectionCard>

      <SectionCard
        title="Available updates"
        description={`${rows.length} component${rows.length === 1 ? "" : "s"} can be updated.`}
        icon={ArrowUpCircle}
        action={<DummyBadge />}
        className="lg:col-span-2"
      >
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden />
            Everything is up to date.
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap justify-end gap-2">
              <button type="button" className={BTN} onClick={() => toast.success(`Demo — ${rows.length} updates would be applied.`)}>
                Update all
              </button>
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={selected.size === 0}
                onClick={() => toast.success(`Demo — ${selected.size} selected update${selected.size === 1 ? "" : "s"} would be applied.`)}
              >
                Update selected ({selected.size})
              </button>
            </div>
            <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {rows.map((row) => {
                const badge = KIND_BADGE[row.kind];
                return (
                  <li key={row.key} className="flex items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(row.key)}
                      onChange={() => toggle(row.key)}
                      aria-label={`Select ${row.name}`}
                      className="h-4 w-4 shrink-0 rounded border-zinc-300 text-sky-600 focus:ring-sky-500 dark:border-zinc-600"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.name}</p>
                      <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                        {row.from} <span aria-hidden>→</span> {row.to}
                      </p>
                    </div>
                    {row.vulnerable ? (
                      <span className={cn(PILL, TONE_PILL.red)}>
                        <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Vulnerable
                      </span>
                    ) : null}
                    <span className={cn(PILL, TONE_PILL[badge.tone])}>{badge.label}</span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
              A pre-update restore point is captured automatically before any update runs · {data.restorePoints.length} retained.
            </p>
          </>
        )}
      </SectionCard>
    </div>
  );
}
