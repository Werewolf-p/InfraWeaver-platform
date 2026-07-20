"use client";
// Inventory panel — every installed plugin + theme read live from the site, with
// allow-listed update / activate / deactivate actions.

import { useState } from "react";
import { CheckCircle2, Palette, Power, Puzzle, RefreshCw, Trash2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { InventoryData } from "../../../lib/manage/probes/inventory";
import { SectionCard } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";
import { BTN_DANGER_GHOST, ConfirmDialog, useActionRunner } from "./manage-ui";

/** A plugin/theme queued for deletion behind a typed-confirm dialog. */
interface DeleteTarget {
  readonly kind: "plugin" | "theme";
  readonly slug: string;
  readonly name: string;
}

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const BTN_SM =
  "inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

type PluginFilter = "all" | "active" | "update";
const FILTERS: ReadonlyArray<{ id: PluginFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "update", label: "Needs update" },
];

export function InventoryPanel({ site }: { site: string }) {
  const state = useManagePanel<InventoryData>(site, "inventory");
  const { run, pending } = useManageAction(site);
  const del = useActionRunner(site);
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  async function apply(action: Parameters<typeof run>[0]) {
    const result = await run(action);
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const action =
      deleteTarget.kind === "plugin"
        ? ({ type: "delete-plugin", slug: deleteTarget.slug } as const)
        : ({ type: "delete-theme", slug: deleteTarget.slug } as const);
    const result = await del.run(action, { onSuccess: () => state.reload() });
    if (result.ok) setDeleteTarget(null);
  }

  return (
    <>
    <PanelState state={state} isEmpty={(d) => d.plugins.length === 0 && d.themes.length === 0} emptyMessage="No plugins or themes are installed.">
      {(data) => {
        const shown = data.plugins.filter((p) =>
          filter === "active" ? p.active : filter === "update" ? p.updateAvailable : true,
        );
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="Installed plugins"
              description={`${data.plugins.length} plugins · ${data.activePlugins} active · ${data.pluginUpdates} need updating`}
              icon={Puzzle}
              action={
                data.pluginUpdates + data.themeUpdates > 0 ? (
                  <button type="button" className={BTN} disabled={pending} onClick={() => apply({ type: "update-all" })}>
                    {pending ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Update all
                  </button>
                ) : null
              }
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
                        on
                          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                          : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
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
                      <th className="py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {shown.map((p) => {
                      const toggleable = p.status === "active" || p.status === "inactive";
                      return (
                        <tr key={p.slug || p.name}>
                          <td className="py-2 pr-3">
                            <p className="font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                            <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.slug || "—"}</p>
                          </td>
                          <td className="py-2 pr-3 font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
                            {p.version ?? "—"}
                            {p.updateAvailable && p.updateVersion ? (
                              <span className="text-sky-600 dark:text-sky-400"> → {p.updateVersion}</span>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3">
                            <span className={cn(PILL, p.active ? TONE_PILL.good : TONE_PILL.neutral)}>
                              {p.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <span className={cn(PILL, p.autoUpdate ? TONE_PILL.sky : TONE_PILL.neutral)}>
                              <Zap className="h-3.5 w-3.5" aria-hidden /> {p.autoUpdate ? "On" : "Off"}
                            </span>
                          </td>
                          <td className="py-2">
                            <div className="flex gap-1.5">
                              {p.updateAvailable && p.canAct ? (
                                <button
                                  type="button"
                                  className={BTN_SM}
                                  disabled={pending}
                                  onClick={() => apply({ type: "update-plugin", slug: p.slug })}
                                >
                                  <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Update
                                </button>
                              ) : null}
                              {p.canAct && toggleable ? (
                                <button
                                  type="button"
                                  className={BTN_SM}
                                  disabled={pending}
                                  onClick={() =>
                                    apply(
                                      p.active
                                        ? { type: "deactivate-plugin", slug: p.slug }
                                        : { type: "activate-plugin", slug: p.slug },
                                    )
                                  }
                                >
                                  <Power className="h-3.5 w-3.5" aria-hidden /> {p.active ? "Deactivate" : "Activate"}
                                </button>
                              ) : null}
                              {p.canAct && !p.active && p.slug ? (
                                <button
                                  type="button"
                                  className={BTN_DANGER_GHOST}
                                  disabled={del.pending}
                                  onClick={() => setDeleteTarget({ kind: "plugin", slug: p.slug, name: p.name })}
                                >
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <SectionCard title="Themes" description={`${data.themes.length} installed.`} icon={Palette} className="lg:col-span-2">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.themes.map((t) => (
                  <div key={t.slug || t.name} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                        <p className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                          {t.version ? `v${t.version}` : t.slug || "—"}
                        </p>
                      </div>
                      <span className={cn(PILL, t.active ? TONE_PILL.good : TONE_PILL.neutral)}>
                        {t.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    {(t.updateAvailable || (!t.active && t.canAct)) ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {t.updateAvailable ? <span className={cn(PILL, TONE_PILL.sky)}>Update available</span> : null}
                        {t.updateAvailable && t.canAct ? (
                          <button
                            type="button"
                            className={BTN_SM}
                            disabled={pending}
                            onClick={() => apply({ type: "update-theme", slug: t.slug })}
                          >
                            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Update
                          </button>
                        ) : null}
                        {!t.active && t.canAct && t.slug ? (
                          <>
                            <button
                              type="button"
                              className={BTN_SM}
                              disabled={pending}
                              onClick={() => apply({ type: "activate-theme", slug: t.slug })}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Activate
                            </button>
                            <button
                              type="button"
                              className={BTN_DANGER_GHOST}
                              disabled={del.pending}
                              onClick={() => setDeleteTarget({ kind: "theme", slug: t.slug, name: t.name })}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={deleteTarget ? `Delete ${deleteTarget.kind} “${deleteTarget.name}”?` : "Delete"}
        description={
          deleteTarget?.kind === "theme"
            ? "The active theme cannot be deleted — activate another theme first."
            : "This removes the plugin and its files from the site."
        }
        confirmLabel={deleteTarget ? `Delete ${deleteTarget.kind}` : "Delete"}
        confirmPhrase={deleteTarget?.slug}
        confirmPhraseLabel="Type the slug to confirm"
        pending={del.pending}
        error={del.error}
      />
    </>
  );
}
