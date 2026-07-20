"use client";
// Inventory panel — every installed plugin + theme read live from the site, with
// allow-listed update / activate / deactivate / delete actions.

import { useState } from "react";
import { CheckCircle2, Palette, Power, Puzzle, RefreshCw, Trash2, Zap } from "lucide-react";
import { toast } from "@/lib/notify";
import type { InventoryData, InventoryPlugin, InventoryTheme } from "../../../lib/manage/probes/inventory";
import { SectionCard } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";
import { BTN, BTN_SM, BTN_DANGER_GHOST, ConfirmDialog, useActionRunner } from "./manage-ui";
import { DataTable, FilterTabs, Pill, type Column, type FilterTabOption } from "./kit";

/** A plugin/theme queued for deletion behind a typed-confirm dialog. */
interface DeleteTarget {
  readonly kind: "plugin" | "theme";
  readonly slug: string;
  readonly name: string;
}

type PluginFilter = "all" | "active" | "update";

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
      <PanelState
        state={state}
        isEmpty={(d) => d.plugins.length === 0 && d.themes.length === 0}
        emptyMessage="No plugins or themes are installed."
      >
        {(data) => {
          const shown = data.plugins.filter((p) =>
            filter === "active" ? p.active : filter === "update" ? p.updateAvailable : true,
          );

          const filterOptions: readonly FilterTabOption<PluginFilter>[] = [
            { value: "all", label: "All", count: data.plugins.length },
            { value: "active", label: "Active", count: data.activePlugins },
            { value: "update", label: "Needs update", count: data.pluginUpdates },
          ];

          const pluginColumns: readonly Column<InventoryPlugin>[] = [
            {
              key: "name",
              header: "Plugin",
              render: (p) => (
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                  <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.slug || "—"}</p>
                </div>
              ),
            },
            {
              key: "version",
              header: "Version",
              render: (p) => (
                <span className="font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
                  {p.version ?? "—"}
                  {p.updateAvailable && p.updateVersion ? (
                    <span className="text-sky-600 dark:text-sky-400"> → {p.updateVersion}</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (p) => <Pill tone={p.active ? "good" : "neutral"}>{p.active ? "Active" : "Inactive"}</Pill>,
            },
            {
              key: "autoUpdate",
              header: "Auto-update",
              render: (p) => (
                <Pill tone={p.autoUpdate ? "info" : "neutral"} icon={Zap}>
                  {p.autoUpdate ? "On" : "Off"}
                </Pill>
              ),
            },
            {
              key: "actions",
              header: "Actions",
              render: (p) => {
                const toggleable = p.status === "active" || p.status === "inactive";
                return (
                  <div className="flex flex-wrap gap-1.5">
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
                );
              },
            },
          ];

          const themeColumns: readonly Column<InventoryTheme>[] = [
            {
              key: "name",
              header: "Theme",
              render: (t) => (
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                  <p className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                    {t.version ? `v${t.version}` : t.slug || "—"}
                  </p>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (t) => <Pill tone={t.active ? "good" : "neutral"}>{t.active ? "Active" : "Inactive"}</Pill>,
            },
            {
              key: "update",
              header: "Update",
              render: (t) =>
                t.updateAvailable ? (
                  <Pill tone="info">Available</Pill>
                ) : (
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">—</span>
                ),
            },
            {
              key: "actions",
              header: "Actions",
              render: (t) => (
                <div className="flex flex-wrap gap-1.5">
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
              ),
            },
          ];

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
                <FilterTabs
                  options={filterOptions}
                  value={filter}
                  onChange={setFilter}
                  ariaLabel="Filter plugins by status"
                  className="mb-3"
                />
                <DataTable
                  caption="Installed plugins with version, status, auto-update and actions"
                  columns={pluginColumns}
                  rows={shown}
                  getRowKey={(p) => p.slug || p.name}
                  empty="No plugins match this filter."
                />
              </SectionCard>

              <SectionCard
                title="Themes"
                description={`${data.themes.length} installed.`}
                icon={Palette}
                className="lg:col-span-2"
              >
                <DataTable
                  caption="Installed themes with version, status, update and actions"
                  columns={themeColumns}
                  rows={data.themes}
                  getRowKey={(t) => t.slug || t.name}
                  empty="No themes are installed."
                />
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
