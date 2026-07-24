"use client";

/**
 * Zone 4 — the bloat drill-down. The table list gains an Overhead column (the
 * reclaimable DATA_FREE that makes Safe optimize worth clicking); the autoload
 * top-offenders appear when weight exceeds the warn threshold (names + byte sizes
 * only — never option values); the cleanup history closes the loop ("why did the
 * DB shrink?"). Overhead is hidden when the signed analyzer is unavailable so the
 * base wp-cli probe still renders sizes without fabricating a zero.
 */

import type { ReactNode } from "react";
import { Database, History, Layers } from "lucide-react";
import { SectionCard } from "../../demo/widgets";
import { DataTable, EmptyState, Pill, type Column } from "../../demo/manage/kit";
import type { DbAutoload, DbHistoryEntry, DbTableRow } from "../../../lib/manage/database";
import { AUTOLOAD_WARN_KB } from "../../../lib/manage/database";
import { fmt, fmtTs } from "./db-format";

const DOMINANT_TABLE_FRACTION = 0.4;

const SOURCE_LABEL: Record<string, string> = {
  manual: "WP-admin",
  scheduled: "Schedule",
  console: "Console",
};

export interface DbBloatProps {
  readonly tables: readonly DbTableRow[];
  /** Sum of table sizes (MB) for the dominant-table pill; null = unknown. */
  readonly totalMb: number | null;
  /** Whether overhead figures are trustworthy (signed analyzer present). */
  readonly overheadKnown: boolean;
  readonly autoload: DbAutoload | null;
  readonly history: readonly DbHistoryEntry[];
}

export function DbBloat({ tables, totalMb, overheadKnown, autoload, history }: DbBloatProps): ReactNode {
  const total = totalMb ?? 0;
  const isDominant = (t: DbTableRow): boolean => total > 0 && t.size_mb >= total * DOMINANT_TABLE_FRACTION;

  const columns: Column<DbTableRow>[] = [
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
    { key: "size", header: "Size (MB)", align: "right", render: (t) => t.size_mb },
  ];
  if (overheadKnown) {
    columns.push({
      key: "overhead",
      header: "Overhead (MB)",
      align: "right",
      render: (t) => (t.overhead_mb > 0 ? <span className="text-amber-600 dark:text-amber-400">{t.overhead_mb}</span> : t.overhead_mb),
    });
  }

  const autoloadHigh = autoload !== null && autoload.kb !== null && autoload.kb > AUTOLOAD_WARN_KB;
  const topOffenders = autoload?.top ?? [];

  return (
    <div className="space-y-5">
      <SectionCard
        title="Database tables"
        description={`${tables.length} table${tables.length === 1 ? "" : "s"}, largest first.${overheadKnown ? " Overhead is reclaimable with Safe optimize." : ""}`}
        icon={Database}
      >
        {tables.length === 0 ? (
          <EmptyState icon={Database} title="No tables to show" body="The database size query returned no tables for this site." />
        ) : (
          <DataTable
            caption="Database tables by size, largest first"
            columns={columns}
            rows={tables}
            getRowKey={(t) => t.name}
            footer={
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">Total</span>
                <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{totalMb !== null ? `${totalMb} MB` : "—"}</span>
              </div>
            }
          />
        )}
      </SectionCard>

      {autoloadHigh && topOffenders.length > 0 ? (
        <SectionCard
          title="Heaviest autoloaded options"
          description={`Autoload weight is ${fmt(autoload?.kb ?? 0)} KB across ${fmt(autoload?.count ?? 0)} options — these load on every request. Names and sizes only; values never leave the site.`}
          icon={Layers}
        >
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {topOffenders.map((opt) => (
              <li key={opt.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{opt.name}</span>
                <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{fmt(opt.kb)} KB</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            A single option over ~100 KB is usually a plugin caching data in options — clearing that plugin's cache or transients
            (above) often shrinks it. Leftover options from removed plugins are common offenders.
          </p>
        </SectionCard>
      ) : null}

      <SectionCard title="Cleanup history" description="The last runs — from the console, WP-admin, or the schedule." icon={History}>
        {history.length === 0 ? (
          <EmptyState icon={History} title="No cleanup yet" body="Once a real cleanup runs, its result appears here." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {history.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Pill tone="neutral">{SOURCE_LABEL[entry.source] ?? entry.source}</Pill>
                  <span className="text-zinc-500 dark:text-zinc-400" title={fmtTs(entry.at)}>
                    {fmtTs(entry.at)}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-zinc-700 dark:text-zinc-200">Removed {fmt(entry.total)} rows</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
