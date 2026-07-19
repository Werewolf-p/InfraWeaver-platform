"use client";
// Updates panel — WordPress core, plugin and theme updates read live from the site.

import { ArrowUpCircle, CheckCircle2, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { UpdatesData, UpdateComponent } from "../../../lib/manage/probes/updates";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50";

const TONE_PILL = {
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

const KIND_BADGE: Record<UpdateComponent["kind"], { label: string; tone: keyof typeof TONE_PILL }> = {
  core: { label: "Core", tone: "sky" },
  plugin: { label: "Plugin", tone: "neutral" },
  theme: { label: "Theme", tone: "neutral" },
};

export function UpdatesPanel({ site }: { site: string }) {
  const state = useManagePanel<UpdatesData>(site, "updates");
  const { run, pending } = useManageAction(site);

  async function apply(action: Parameters<typeof run>[0], reloadAfter: () => void) {
    const result = await run(action);
    if (result.ok) {
      toast.success(result.message);
      reloadAfter();
    } else {
      toast.error(result.message);
    }
  }

  return (
    <PanelState state={state}>
      {(data) => {
        const rows = data.components;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
              <StatTile
                label="Pending"
                value={rows.length}
                icon={ArrowUpCircle}
                tone={healthTone(rows.length === 0 ? 96 : rows.length < 4 ? 74 : 46)}
              />
              <StatTile label="Auto-update on" value={data.autoUpdatePlugins} icon={Zap} tone={healthTone(data.autoUpdatePlugins > 0 ? 90 : 55)} />
              <StatTile label="Plugins installed" value={data.totalPlugins} icon={RefreshCw} tone={healthTone(80)} />
            </div>

            <SectionCard title="WordPress core" description={`Release state for ${site}.`} icon={RefreshCw}>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Version</p>
                    <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {data.core.current ?? "—"}
                      {!data.core.upToDate && data.core.latest ? (
                        <>
                          {" "}
                          <span aria-hidden>→</span> {data.core.latest}
                        </>
                      ) : null}
                    </p>
                  </div>
                  {data.core.upToDate ? (
                    <span className={cn(PILL, TONE_PILL.good)}>
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Up to date
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={pending}
                      onClick={() => apply({ type: "update-core" }, state.reload)}
                    >
                      {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Update core
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">PHP runtime</p>
                    <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">PHP {data.core.php ?? "—"}</p>
                  </div>
                  <span className={cn(PILL, TONE_PILL.neutral)}>
                    <Zap className="h-3.5 w-3.5" aria-hidden /> {data.autoUpdatePlugins} auto-updating
                  </span>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Available updates"
              description={`${rows.length} component${rows.length === 1 ? "" : "s"} can be updated.`}
              icon={ArrowUpCircle}
            >
              {rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden />
                  Everything is up to date.
                </div>
              ) : (
                <>
                  <div className="mb-3 flex justify-end">
                    <button
                      type="button"
                      className={BTN}
                      disabled={pending}
                      onClick={() => apply({ type: "update-all" }, state.reload)}
                    >
                      {pending ? <Spinner /> : null} Update all
                    </button>
                  </div>
                  <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                    {rows.map((row) => {
                      const badge = KIND_BADGE[row.kind];
                      const canUpdateOne = row.kind === "plugin" || row.kind === "theme";
                      return (
                        <li key={`${row.kind}:${row.slug}`} className="flex items-center gap-3 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.name}</p>
                            <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                              {row.from} <span aria-hidden>→</span> {row.to}
                            </p>
                          </div>
                          <span className={cn(PILL, TONE_PILL[badge.tone])}>{badge.label}</span>
                          {canUpdateOne ? (
                            <button
                              type="button"
                              className={BTN}
                              disabled={pending}
                              onClick={() =>
                                apply(
                                  row.kind === "plugin"
                                    ? { type: "update-plugin", slug: row.slug }
                                    : { type: "update-theme", slug: row.slug },
                                  state.reload,
                                )
                              }
                            >
                              Update
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
