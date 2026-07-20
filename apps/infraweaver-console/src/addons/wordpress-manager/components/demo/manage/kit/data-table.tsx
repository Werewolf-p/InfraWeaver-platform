"use client";

/**
 * Shared, accessible + RESPONSIVE data table for the WordPress Manage console.
 *
 * Desktop (md and up): a real semantic `<table>` with an sr-only `<caption>`,
 * `scope="col"` headers, a sticky header row, zebra `divide-y` body and
 * right-aligned numeric cells rendered `tabular-nums`.
 *
 * Phone (below md): a horizontally-scrolling table is a bad phone experience, so
 * the SAME columns/rows render as a VERTICAL STACK OF CARDS instead — one card per
 * row, each column shown as a `label : value` pair (the column header is the
 * label). This is why fixing the table here fixes the phone layout of every
 * table-heavy panel (Users, Plugins, Database, Media, Backups, Content, Updates…)
 * at once. Columns opt into card behaviour with `primary` (becomes the card's
 * title) and `mobileHidden` (dropped from the card); a column with an empty header
 * (e.g. a row-actions column) renders full-width at the foot of the card.
 *
 * Column bodies are supplied by the caller via `render` so the table stays
 * layout-only. When there are no rows it renders the `empty` node instead of a
 * lonely header shell.
 */

import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ColumnAlign = "left" | "right" | "center";

export interface Column<T> {
  /** Stable, unique key for the column (also used as the React key for cells). */
  readonly key: string;
  readonly header: ReactNode;
  readonly align?: ColumnAlign;
  readonly render: (row: T) => ReactNode;
  /** Extra classes for every body `<td>` in this column. */
  readonly className?: string;
  /** Extra classes for the column's `<th>`. */
  readonly headClassName?: string;
  /** Phone card: this column's value is the card's title (defaults to the first column). */
  readonly primary?: boolean;
  /** Phone card: omit this column from the card entirely (e.g. a bulk-select checkbox). */
  readonly mobileHidden?: boolean;
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  /** Screen-reader caption describing the table (rendered `sr-only`). */
  readonly caption: string;
  readonly getRowKey: (row: T, index: number) => string | number;
  /** Rendered in place of the table body when there are no rows. */
  readonly empty?: ReactNode;
  /** Optional footer row content (spans all columns / sits under the card list). */
  readonly footer?: ReactNode;
  readonly className?: string;
}

function headAlign(align?: ColumnAlign): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function cellAlign(align?: ColumnAlign): string {
  // Numeric columns are right-aligned and want figure-aligned digits.
  if (align === "right") return "text-right tabular-nums";
  if (align === "center") return "text-center";
  return "text-left";
}

/** A column with an empty/whitespace header carries no useful mobile label. */
function hasLabel(header: ReactNode): boolean {
  return !(header === null || header === undefined || header === "" || (typeof header === "string" && header.trim() === ""));
}

const SHELL = "rounded-xl border border-zinc-200 dark:border-zinc-800";

/** One row rendered as a stacked phone card: title + label/value pairs + a full-width action foot. */
function MobileCard<T>({ row, columns }: { row: T; columns: readonly Column<T>[] }): JSX.Element {
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary && !c.mobileHidden);
  const labelled = rest.filter((c) => hasLabel(c.header));
  const actionCols = rest.filter((c) => !hasLabel(c.header));

  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{primary.render(row)}</div>
      {labelled.length > 0 ? (
        <dl className="mt-2 space-y-1.5 text-sm">
          {labelled.map((col) => (
            <div key={col.key} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {col.header}
              </dt>
              <dd className={cn("min-w-0 text-right text-zinc-800 dark:text-zinc-200", col.align === "right" && "tabular-nums")}>
                {col.render(row)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actionCols.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800/70">
          {actionCols.map((col) => (
            <div key={col.key} className="min-w-0">{col.render(row)}</div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function DataTable<T>({
  columns,
  rows,
  caption,
  getRowKey,
  empty,
  footer,
  className,
}: DataTableProps<T>): JSX.Element {
  // No rows → render the empty node, never an empty header shell.
  if (rows.length === 0) {
    return (
      <div className={cn(SHELL, className)}>
        <div className="px-3 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{empty ?? "No data"}</div>
      </div>
    );
  }

  return (
    <div className={cn(className)}>
      {/* Phone: vertical card stack (no horizontal scroll). */}
      <ul aria-label={caption} className="space-y-2.5 md:hidden">
        {rows.map((row, index) => (
          <MobileCard key={getRowKey(row, index)} row={row} columns={columns} />
        ))}
        {footer ? (
          <li className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
            {footer}
          </li>
        ) : null}
      </ul>

      {/* Desktop: the real table, horizontally scrollable only as a last resort. */}
      <div className={cn(SHELL, "hidden overflow-x-auto md:block")}>
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cn(
                    "sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/95 px-3 py-2 font-medium backdrop-blur supports-[backdrop-filter]:bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/95 dark:supports-[backdrop-filter]:bg-zinc-900/80",
                    headAlign(col.align),
                    col.headClassName,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((row, index) => (
              <tr
                key={getRowKey(row, index)}
                className="transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30"
              >
                {columns.map((col) => (
                  <td key={col.key} className={cn("px-3 py-2 align-middle", cellAlign(col.align), col.className)}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer ? (
            <tfoot>
              <tr className="border-t border-zinc-200 dark:border-zinc-800">
                <td colSpan={columns.length} className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                  {footer}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
