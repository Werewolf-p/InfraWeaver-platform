"use client";

/**
 * Shared, accessible data table for the WordPress Manage console. A real semantic
 * `<table>` with an sr-only `<caption>`, `scope="col"` headers, a sticky header row,
 * zebra `divide-y` body and right-aligned numeric cells rendered `tabular-nums`.
 * Column bodies are supplied by the caller via `render` so the table stays layout-only
 * and every panel gets identical structure/behaviour. When there are no rows it renders
 * the `empty` node instead of a lonely header shell.
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
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  /** Screen-reader caption describing the table (rendered `sr-only`). */
  readonly caption: string;
  readonly getRowKey: (row: T, index: number) => string | number;
  /** Rendered in place of the table body when there are no rows. */
  readonly empty?: ReactNode;
  /** Optional footer row content (spans all columns). */
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

const SHELL = "overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800";

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
    <div className={cn(SHELL, className)}>
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
  );
}
