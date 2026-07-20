"use client";
// Updates panel — WordPress core, plugin and theme updates read live from the
// site, rendered on the shared Manage kit (DataTable / Pill / EmptyState).
// "Update all" is the primary CTA; each row can also update on its own, showing
// an optimistic per-row progress ring instead of one global spinner.

import { useState } from "react";
import { ArrowUpCircle, CheckCircle2, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { toast } from "@/lib/notify";
import type { UpdatesData, UpdateComponent } from "../../../lib/manage/probes/updates";
import { ProgressRing, SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";
import { BTN_PRIMARY, BTN_SM } from "./manage-ui";
import { DataTable, EmptyState, Pill, type Column, type PillTone } from "./kit";

/** Arbitrary "in flight" fill for the optimistic per-row ring (no real %). */
const UPDATING_PROGRESS = 66;

const KIND_BADGE: Record<UpdateComponent["kind"], { readonly label: string; readonly tone: PillTone }> = {
  core: { label: "Core", tone: "info" },
  plugin: { label: "Plugin", tone: "neutral" },
  theme: { label: "Theme", tone: "neutral" },
};

/** Stable row/action key for a component (also the react key). */
function rowKey(row: UpdateComponent): string {
  return `${row.kind}:${row.slug}`;
}

export function UpdatesPanel({ site }: { site: string }) {
  const state = useManagePanel<UpdatesData>(site, "updates");
  const { run } = useManageAction(site);
  // Which action is running (row key, "core", or "all") so a single row shows an
  // optimistic "Updating…" state instead of a global spinner.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function apply(action: Parameters<typeof run>[0], key: string) {
    setBusyKey(key);
    const result = await run(action);
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
    setBusyKey(null);
  }

  return (
    <PanelState state={state}>
      {(data) => {
        const rows = data.components;
        // "Update all" only touches plugins + themes (core has its own path).
        const bulk = rows.filter((row) => row.kind !== "core");
        const busy = busyKey !== null;
        const ringTone = healthTone(80);

        const columns: readonly Column<UpdateComponent>[] = [
          {
            key: "component",
            header: "Component",
            render: (row) => {
              const badge = KIND_BADGE[row.kind];
              return (
                <div className="flex min-w-0 items-center gap-2">
                  <Pill tone={badge.tone}>{badge.label}</Pill>
                  <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{row.name}</span>
                </div>
              );
            },
          },
          {
            key: "version",
            header: "Version",
            render: (row) => (
              <span className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                {row.from} <span aria-hidden>→</span> {row.to}
              </span>
            ),
          },
          {
            key: "action",
            header: "",
            align: "right",
            render: (row) => {
              // Core updates through its own card above, not per-row.
              if (row.kind !== "plugin" && row.kind !== "theme") return null;
              const key = rowKey(row);
              if (busyKey === key) {
                return (
                  <span className="inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <ProgressRing value={UPDATING_PROGRESS} tone={ringTone} size={28} /> Updating…
                  </span>
                );
              }
              return (
                <button
                  type="button"
                  className={BTN_SM}
                  disabled={busy}
                  onClick={() =>
                    apply(
                      row.kind === "plugin"
                        ? { type: "update-plugin", slug: row.slug }
                        : { type: "update-theme", slug: row.slug },
                      key,
                    )
                  }
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Update
                </button>
              );
            },
          },
        ];

        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
              <StatTile
                label="Pending"
                value={rows.length}
                icon={ArrowUpCircle}
                tone={healthTone(rows.length === 0 ? 96 : rows.length < 4 ? 74 : 46)}
              />
              <StatTile
                label="Auto-update on"
                value={data.autoUpdatePlugins}
                icon={Zap}
                tone={healthTone(data.autoUpdatePlugins > 0 ? 90 : 55)}
              />
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
                    <Pill tone="good" icon={ShieldCheck}>
                      Up to date
                    </Pill>
                  ) : (
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={busy}
                      onClick={() => apply({ type: "update-core" }, "core")}
                    >
                      {busyKey === "core" ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Update core
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">PHP runtime</p>
                    <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">PHP {data.core.php ?? "—"}</p>
                  </div>
                  <Pill tone="neutral" icon={Zap}>
                    {data.autoUpdatePlugins} auto-updating
                  </Pill>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Available updates"
              description={`${rows.length} component${rows.length === 1 ? "" : "s"} can be updated.`}
              icon={ArrowUpCircle}
              action={
                bulk.length > 0 ? (
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    disabled={busy}
                    onClick={() => apply({ type: "update-all" }, "all")}
                  >
                    {busyKey === "all" ? <Spinner /> : <ArrowUpCircle className="h-4 w-4" aria-hidden />} Update all (
                    {bulk.length})
                  </button>
                ) : null
              }
            >
              {rows.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="Everything is up to date"
                  body="Core, plugins and themes are all on their latest versions."
                />
              ) : (
                <DataTable
                  caption="Available core, plugin and theme updates"
                  columns={columns}
                  rows={rows}
                  getRowKey={rowKey}
                />
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
