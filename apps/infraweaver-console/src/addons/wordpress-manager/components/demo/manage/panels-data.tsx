"use client";

// Database panel — table sizes, autoload weight, transients and revisions read
// live from the site, rendered on the shared Manage kit (DataTable / Pill /
// EmptyState). The two mutations (Optimize tables, Purge temporary data) go
// through the allow-listed Manage actions via `useActionRunner`; Optimize is
// gated behind a confirm dialog because it briefly locks each table.
import { useState } from "react";
import { AlertTriangle, Database, History, Layers, Trash2, Wrench } from "lucide-react";
import type { DataPanelData, DbTable } from "../../../lib/manage/probes/data";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { BTN, ConfirmDialog, useActionRunner } from "./manage-ui";
import { DataTable, EmptyState, Pill, type Column } from "./kit";

/** Autoload weight over ~800 KB starts to drag every page load. */
const AUTOLOAD_WARN_KB = 800;
/** A single table taking ≥40% of the whole database is worth calling out. */
const DOMINANT_TABLE_FRACTION = 0.4;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function DataPanel({ site }: { site: string }) {
  const state = useManagePanel<DataPanelData>(site, "data");
  const runner = useActionRunner(site);
  const [optimizeOpen, setOptimizeOpen] = useState(false);

  function purge() {
    void runner.run({ type: "purge-transients" }, { onSuccess: () => state.reload() });
  }

  function optimize() {
    void runner.run(
      { type: "optimize-db" },
      {
        onSuccess: () => {
          state.reload();
          setOptimizeOpen(false);
        },
      },
    );
  }

  return (
    <>
      <PanelState state={state}>
        {(data) => {
          const totalMb = data.totalMb ?? 0;
          const autoloadHigh = data.autoloadKb !== null && data.autoloadKb > AUTOLOAD_WARN_KB;
          const autoloadTone = healthTone(autoloadHigh ? 55 : 92);
          const isDominant = (t: DbTable): boolean => totalMb > 0 && t.sizeMb >= totalMb * DOMINANT_TABLE_FRACTION;

          const columns: readonly Column<DbTable>[] = [
            {
              key: "name",
              header: "Table",
              render: (t) => (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{t.name}</span>
                  {isDominant(t) ? <Pill tone="warn">Large</Pill> : null}
                </span>
              ),
            },
            {
              key: "size",
              header: "Size (MB)",
              align: "right",
              render: (t) => t.sizeMb,
            },
          ];

          return (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
                <div title="Total size of this site's database on disk">
                  <StatTile label="Total size" value={totalMb} decimals={1} suffix=" MB" icon={Database} />
                </div>
                <div title={`Autoload weight — ${fmt(data.autoloadCount)} options WordPress loads on every request`}>
                  <StatTile
                    label="Slow-load weight"
                    value={data.autoloadKb ?? 0}
                    decimals={1}
                    suffix=" KB"
                    icon={Layers}
                    tone={autoloadTone}
                  />
                </div>
                <div title="Transients — cached temporary values that expire on their own">
                  <StatTile
                    label="Temporary data"
                    value={data.transients}
                    icon={Trash2}
                    tone={healthTone(data.transients > 500 ? 55 : 90)}
                  />
                </div>
                <div title="Post revisions — older saved drafts kept in the edit history">
                  <StatTile
                    label="Old drafts"
                    value={data.revisions}
                    icon={History}
                    tone={healthTone(data.revisions > 200 ? 60 : 90)}
                  />
                </div>
              </div>

              {autoloadHigh ? (
                <div className="lg:col-span-2">
                  <Pill tone="warn" icon={AlertTriangle}>
                    Slow-load weight is high
                  </Pill>
                </div>
              ) : null}

              <SectionCard
                className="lg:col-span-2"
                title="Database tables"
                description={`${data.tables.length} table${data.tables.length === 1 ? "" : "s"}, largest first.`}
                icon={Database}
              >
                {data.tables.length === 0 ? (
                  <EmptyState
                    icon={Database}
                    title="No tables to show"
                    body="The database size query returned no tables for this site."
                  />
                ) : (
                  <DataTable
                    caption="Database tables by size, largest first"
                    columns={columns}
                    rows={data.tables}
                    getRowKey={(t) => t.name}
                    footer={
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-zinc-700 dark:text-zinc-200">Total</span>
                        <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                          {data.totalMb !== null ? `${data.totalMb} MB` : "—"}
                        </span>
                      </div>
                    }
                  />
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className={BTN} disabled={runner.pending} onClick={() => setOptimizeOpen(true)}>
                    <Wrench className="h-4 w-4" aria-hidden /> Optimize tables
                  </button>
                  <button type="button" className={BTN} disabled={runner.pending} onClick={purge}>
                    {runner.pending ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />} Purge temporary data
                  </button>
                </div>
              </SectionCard>
            </div>
          );
        }}
      </PanelState>

      <ConfirmDialog
        open={optimizeOpen}
        onClose={() => {
          setOptimizeOpen(false);
          runner.clearError();
        }}
        onConfirm={optimize}
        title="Optimize database tables?"
        description="Reclaims space and defragments the tables. Each table is locked briefly while it runs, so prefer a quiet moment."
        confirmLabel="Optimize tables"
        tone="neutral"
        pending={runner.pending}
        error={runner.error}
      />
    </>
  );
}
