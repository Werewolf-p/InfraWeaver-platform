"use client";
// Inventory panel — installed plugins table + theme gallery (demo, fake data).

import { useState } from "react";
import { Palette, Power, Puzzle, ShieldAlert, Trash2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageData } from "../site-manage-data";
import { SectionCard } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const BTN_SM =
  "inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  red: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

type PluginFilter = "all" | "active" | "update";
const FILTERS: ReadonlyArray<{ id: PluginFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "update", label: "Needs update" },
];

export function InventoryPanel({ data }: { data: SiteManageData; site: string }) {
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [autoOn, setAutoOn] = useState<Set<string>>(() => new Set(data.plugins.filter((p) => p.autoUpdate).map((p) => p.slug)));

  const toggleAuto = (slug: string, name: string) => {
    setAutoOn((prev) => {
      const next = new Set(prev);
      const on = next.has(slug);
      if (on) next.delete(slug);
      else next.add(slug);
      toast.info(`Demo — auto-update ${on ? "disabled" : "enabled"} for ${name}.`);
      return next;
    });
  };

  const activeTotal = data.plugins.filter((p) => p.active).length;
  const updateTotal = data.plugins.filter((p) => p.updateType !== null).length;
  const shown = data.plugins.filter((p) => (filter === "active" ? p.active : filter === "update" ? p.updateType !== null : true));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Installed plugins"
        description={`${data.plugins.length} plugins · ${activeTotal} active · ${updateTotal} need updating`}
        icon={Puzzle}
        action={<DummyBadge />}
        className="lg:col-span-2"
      >
        <div className="mb-3 inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-950/40">
          {FILTERS.map((f) => {
            const on = f.id === filter;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  on ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3 font-medium">Plugin</th>
                <th className="py-2 pr-3 font-medium">Version</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Auto-update</th>
                <th className="py-2 pr-3 font-medium">Security</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {shown.map((p) => {
                const auto = autoOn.has(p.slug);
                return (
                  <tr key={p.slug}>
                    <td className="py-2 pr-3">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                      <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.author}</p>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
                      {p.version}
                      {p.updateType ? <span className="text-sky-600 dark:text-sky-400"> → {p.latest}</span> : null}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={cn(PILL, p.active ? TONE_PILL.good : TONE_PILL.neutral)}>{p.active ? "Active" : "Inactive"}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        aria-pressed={auto}
                        onClick={() => toggleAuto(p.slug, p.name)}
                        className={cn(PILL, "cursor-pointer transition-colors", auto ? TONE_PILL.sky : TONE_PILL.neutral)}
                      >
                        <Zap className="h-3.5 w-3.5" aria-hidden /> {auto ? "On" : "Off"}
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      {p.vulnerable ? (
                        <span className={cn(PILL, TONE_PILL.red)}>
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> CVE
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          className={BTN_SM}
                          onClick={() => toast.info(`Demo — ${p.name} would be ${p.active ? "deactivated" : "activated"}.`)}
                        >
                          <Power className="h-3.5 w-3.5" aria-hidden /> {p.active ? "Deactivate" : "Activate"}
                        </button>
                        <button type="button" className={BTN_SM} onClick={() => toast.info(`Demo — ${p.name} would be deleted.`)}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Themes" description={`${data.themes.length} installed.`} icon={Palette} action={<DummyBadge />} className="lg:col-span-2">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.themes.map((t) => (
            <div key={t.slug} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className={cn("aspect-video rounded-lg bg-gradient-to-br", t.swatch)} aria-hidden />
              <div className="mt-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                  <p className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">v{t.version}</p>
                </div>
                {t.active ? (
                  <span className={cn(PILL, TONE_PILL.good)}>Active</span>
                ) : (
                  <button type="button" className={BTN} onClick={() => toast.info(`Demo — ${t.name} would be activated.`)}>
                    Activate
                  </button>
                )}
              </div>
              {t.updateAvailable ? (
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className={cn(PILL, TONE_PILL.sky)}>Update available</span>
                  <button type="button" className={BTN_SM} onClick={() => toast.success(`Demo — ${t.name} would update to ${t.latest}.`)}>
                    Update
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
