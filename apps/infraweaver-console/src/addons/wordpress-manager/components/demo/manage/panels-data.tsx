"use client";

// Database panel — table sizes, autoload weight, transients and revisions read
// live from the site. The two mutations (Optimize tables, Purge transients) go
// through the allow-listed Manage actions; everything else is read-only.
import { Database, History, Layers, Trash2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { DataPanelData } from "../../../lib/manage/probes/data";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManageAction, useManagePanel } from "./use-manage";

const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** Autoload weight over ~800 KB starts to drag every page load. */
const AUTOLOAD_WARN_KB = 800;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function DataPanel({ site }: { site: string }) {
  const state = useManagePanel<DataPanelData>(site, "data");
  const { run, pending } = useManageAction(site);

  async function apply(action: Parameters<typeof run>[0]) {
    const result = await run(action);
    if (result.ok) {
      toast.success(result.message);
      state.reload();
    } else {
      toast.error(result.message);
    }
  }

  return (
    <PanelState state={state}>
      {(data) => {
        const autoloadTone = healthTone(data.autoloadKb !== null && data.autoloadKb > AUTOLOAD_WARN_KB ? 55 : 92);
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
              <StatTile label="Database size" value={data.totalMb ?? 0} decimals={1} suffix=" MB" icon={Database} />
              <StatTile label="Autoload weight" value={data.autoloadKb ?? 0} decimals={1} suffix=" KB" icon={Layers} tone={autoloadTone} />
              <StatTile label="Transients" value={data.transients} icon={Trash2} tone={healthTone(data.transients > 500 ? 55 : 90)} />
              <StatTile label="Revisions" value={data.revisions} icon={History} tone={healthTone(data.revisions > 200 ? 60 : 90)} />
            </div>

            <SectionCard
              className="lg:col-span-2"
              title="Database tables"
              description={`${data.tables.length} table${data.tables.length === 1 ? "" : "s"}, largest first.`}
              icon={Database}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-4 font-medium">Table</th>
                      <th className="py-2 font-medium text-right">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.tables.map((t) => (
                      <tr key={t.name} className="text-zinc-700 dark:text-zinc-300">
                        <td className="py-2 pr-4 font-mono text-[11px]">{t.name}</td>
                        <td className="py-2 text-right tabular-nums">{t.sizeMb} MB</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-zinc-200 font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 text-right tabular-nums">{data.totalMb !== null ? `${data.totalMb} MB` : "—"}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => apply({ type: "optimize-db" })} disabled={pending} className={BTN}>
                  {pending ? <Spinner /> : <Wrench className="h-4 w-4" aria-hidden />} Optimize tables
                </button>
                <button type="button" onClick={() => apply({ type: "purge-transients" })} disabled={pending} className={BTN}>
                  {pending ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />} Purge transients
                </button>
              </div>
            </SectionCard>

            <SectionCard
              className="lg:col-span-2"
              title="Options table"
              description="Autoloaded options load on every request — keep them lean."
              icon={Layers}
            >
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Autoloaded options</dt>
                  <dd className="tabular-nums text-sm text-zinc-900 dark:text-zinc-100">{fmt(data.autoloadCount)}</dd>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Autoload weight</dt>
                  <dd
                    className={cn(
                      "tabular-nums text-sm",
                      data.autoloadKb !== null && data.autoloadKb > AUTOLOAD_WARN_KB
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-zinc-900 dark:text-zinc-100",
                    )}
                  >
                    {data.autoloadKb !== null ? `${data.autoloadKb} KB` : "—"}
                  </dd>
                </div>
              </dl>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
