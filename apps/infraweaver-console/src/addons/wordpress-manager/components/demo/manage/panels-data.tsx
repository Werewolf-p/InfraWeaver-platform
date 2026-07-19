"use client";

// Database tab for the per-site "Manage" demo console — tables, storage breakdown, env facts.
import { Database, HardDrive, Layers, MemoryStick, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageData } from "../site-manage-data";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const NEUTRAL_PILL =
  "inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");
const fmt = (n: number) => n.toLocaleString("en-US");

export function DataPanel({ data }: { data: SiteManageData; site: string }) {
  const { dbTables, dbTotalMb, dbOverheadMb, storage, env } = data;
  const diskTone = healthTone(100 - env.diskUsedPct);
  const cacheTone = env.objectCache === "none" ? healthTone(42) : healthTone(92);
  const storageTotal = storage.reduce((sum, s) => sum + s.gb, 0);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
        <StatTile label="Database size" value={dbTotalMb} decimals={1} suffix=" MB" icon={Database} />
        <StatTile label="Overhead" value={dbOverheadMb} decimals={1} suffix=" MB" icon={Layers} tone={healthTone(dbOverheadMb > 5 ? 55 : 92)} />
        <StatTile label="Disk used" value={env.diskUsedPct} suffix="%" icon={HardDrive} tone={diskTone} />
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
          <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            <span className={cn("grid h-6 w-6 place-items-center rounded-md", cacheTone.soft, cacheTone.text)}>
              <MemoryStick className="h-3.5 w-3.5" aria-hidden />
            </span>
            Object cache
          </span>
          <div className="mt-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {env.objectCache === "none" ? "None" : env.objectCache}
          </div>
        </div>
      </div>

      <SectionCard
        className="lg:col-span-2"
        title="Database tables"
        description="Row counts, size and reclaimable overhead per table."
        icon={Database}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Table</th>
                <th className="py-2 pr-4 text-right font-medium">Rows</th>
                <th className="py-2 pr-4 text-right font-medium">Size</th>
                <th className="py-2 pr-4 text-right font-medium">Overhead</th>
                <th className="py-2 font-medium">Engine</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {dbTables.map((t) => (
                <tr key={t.name} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-mono text-[11px]">{t.name}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{fmt(t.rows)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{t.sizeMb} MB</td>
                  <td
                    className={cn(
                      "py-2 pr-4 text-right tabular-nums",
                      t.overheadKb > 500 ? "text-amber-600 dark:text-amber-400" : "",
                    )}
                  >
                    {t.overheadKb} KB
                  </td>
                  <td className="py-2">
                    <span className={NEUTRAL_PILL}>{t.engine}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-200 font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
                <td className="py-2 pr-4">Total</td>
                <td className="py-2 pr-4" />
                <td className="py-2 pr-4 text-right tabular-nums">{dbTotalMb} MB</td>
                <td className="py-2 pr-4 text-right tabular-nums">{dbOverheadMb} MB</td>
                <td className="py-2" />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={demo} className={BTN}>
            <Layers className="h-4 w-4" aria-hidden /> Optimize tables
          </button>
          <button type="button" onClick={demo} className={BTN}>
            <Trash2 className="h-4 w-4" aria-hidden /> Clean up (revisions, transients, spam)
          </button>
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Storage breakdown"
        description={`${storageTotal.toFixed(1)} GB used across this site.`}
        icon={HardDrive}
        action={<DummyBadge />}
      >
        <div className="flex h-3 w-full overflow-hidden rounded-full">
          {storage.map((s) => (
            <div
              key={s.label}
              style={{ width: `${(s.gb / storageTotal) * 100}%`, backgroundColor: s.color }}
              aria-hidden
            />
          ))}
        </div>
        <ul className="mt-4 space-y-2">
          {storage.map((s) => (
            <li key={s.label} className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
              <span className="text-zinc-700 dark:text-zinc-300">{s.label}</span>
              <span className="ml-auto tabular-nums text-zinc-500 dark:text-zinc-400">{s.gb} GB</span>
            </li>
          ))}
          <li className="flex items-center gap-2 border-t border-zinc-200 pt-2 text-sm font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
            <span>Total</span>
            <span className="ml-auto tabular-nums">{storageTotal.toFixed(1)} GB</span>
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}
