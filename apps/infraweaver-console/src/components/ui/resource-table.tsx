"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Columns3 } from "lucide-react";
import { useSettingsContext } from "@/contexts/settings-context";
import { HorizontalScrollHint } from "@/components/ui/horizontal-scroll-hint";
import { SortableHeader } from "@/components/ui/sortable-header";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  className?: string;
  render?: (row: T) => React.ReactNode;
  mobileHide?: boolean;
}

interface ResourceTableProps<T extends object> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  getRowKey?: (row: T) => string;
  mobileCardRender?: (row: T) => React.ReactNode;
  className?: string;
  tableId?: string;
  caption?: string;
}

interface StoredTableState {
  sortKey: string | null;
  sortDir: "asc" | "desc";
  visibleColumns: string[];
}

function readStoredTableState(tableId?: string): StoredTableState | null {
  if (!tableId || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`infraweaver-table:${tableId}`);
    return raw ? JSON.parse(raw) as StoredTableState : null;
  } catch {
    return null;
  }
}

export function ResourceTable<T extends object>({
  columns,
  data,
  loading,
  empty,
  onRowClick,
  selectable,
  getRowKey,
  mobileCardRender,
  className,
  tableId,
  caption,
}: ResourceTableProps<T>) {
  const storedState = readStoredTableState(tableId);
  const { settings } = useSettingsContext();
  const [sortKey, setSortKey] = useState<string | null>(() => storedState?.sortKey ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => storedState?.sortDir ?? "asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showColumnsMenu, setShowColumnsMenu] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => new Set(storedState?.visibleColumns?.length ? storedState.visibleColumns : columns.map((column) => column.key)));

  useEffect(() => {
    if (!tableId) return;
    try {
      localStorage.setItem(
        `infraweaver-table:${tableId}`,
        JSON.stringify({
          sortKey,
          sortDir,
          visibleColumns: Array.from(visibleColumns),
        } satisfies StoredTableState),
      );
    } catch {
      /* ignore */
    }
  }, [sortDir, sortKey, tableId, visibleColumns]);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleColumnKeys = useMemo(() => {
    const allowedKeys = new Set(columns.map((column) => column.key));
    const storedKeys = Array.from(visibleColumns).filter((key) => allowedKeys.has(key));
    return new Set(storedKeys.length ? storedKeys : columns.map((column) => column.key));
  }, [columns, visibleColumns]);

  const activeColumns = useMemo(() => columns.filter((column) => visibleColumnKeys.has(column.key)), [columns, visibleColumnKeys]);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const left = a as Record<string, unknown>;
      const right = b as Record<string, unknown>;
      const av = left[sortKey];
      const bv = right[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortDir, sortKey]);

  const rowPadding = settings.density === "compact" ? "py-2" : "py-3";

  if (loading) {
    return (
      <div className={cn("space-y-2", className)}>
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-200 dark:bg-[#2a2a2a]" style={{ opacity: 1 - i * 0.15 }} />
        ))}
      </div>
    );
  }

  if (!data.length && empty) {
    return <div className={className}>{empty}</div>;
  }

  return (
    <div className={cn("w-full", className)}>
      {mobileCardRender ? (
        <div className="space-y-2 md:hidden">
          {sorted.map((row, i) => {
            const key = getRowKey ? getRowKey(row) : String(i);
            return (
              <div
                key={key}
                onClick={() => onRowClick?.(row)}
                className={cn(
                  "rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-[#2a2a2a] dark:bg-[#1a1a1a]",
                  onRowClick && "cursor-pointer hover:border-sky-300 dark:hover:border-[#0078D4]/30",
                )}
              >
                {mobileCardRender(row)}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className={cn("space-y-3", mobileCardRender ? "hidden md:block" : "block")}>
        {columns.length > 1 ? (
          <div className="flex justify-end">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowColumnsMenu((value) => !value)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:text-slate-950 dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#b8b8b8] dark:hover:text-white"
              >
                <Columns3 className="h-3.5 w-3.5" />
                Columns
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showColumnsMenu && "rotate-180")} />
              </button>
              {showColumnsMenu ? (
                <div className="absolute right-0 z-20 mt-2 min-w-52 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl dark:border-[#2a2a2a] dark:bg-[#111]">
                  {columns.map((column) => {
                    const checked = visibleColumnKeys.has(column.key);
                    return (
                      <button
                        key={column.key}
                        type="button"
                        onClick={() => {
                          setVisibleColumns((prev) => {
                            const next = new Set(prev);
                            if (checked && Array.from(visibleColumnKeys).length === 1) return next;
                            if (next.has(column.key)) next.delete(column.key);
                            else next.add(column.key);
                            return next;
                          });
                        }}
                        className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-white/5"
                      >
                        <span>{column.label}</span>
                        {checked ? <Check className="h-4 w-4 text-sky-500" /> : <span className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <HorizontalScrollHint
          className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-[#2a2a2a] dark:bg-[#111]"
          contentClassName="rounded-2xl"
          hint="Scroll table"
        >
          <table className="w-full min-w-[720px] text-sm">
            {caption ? <caption className="sr-only">{caption}</caption> : null}
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-slate-200 bg-slate-50/95 dark:border-[#2a2a2a] dark:bg-[#141414]/95">
                {selectable ? (
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 dark:border-[#333]"
                      onChange={(event) => setSelected(event.target.checked ? new Set(sorted.map((row, index) => getRowKey ? getRowKey(row) : String(index))) : new Set())}
                    />
                  </th>
                ) : null}
                {activeColumns.map((column) => (
                  <th key={column.key} className={cn("px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-[#9e9e9e]", column.className)}>
                    {column.sortable ? (
                      <SortableHeader
                        label={column.label}
                        sortKey={column.key}
                        activeKey={sortKey}
                        direction={sortDir}
                        onSort={handleSort}
                      />
                    ) : (
                      <span>{column.label}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const key = getRowKey ? getRowKey(row) : String(i);
                const cellRow = row as Record<string, unknown>;
                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick?.(row)}
                    className={cn(
                      "border-b border-slate-200 transition-colors last:border-0 dark:border-[#2a2a2a]",
                      onRowClick && "cursor-pointer hover:bg-slate-50 dark:hover:bg-[#2a2a2a]",
                      selected.has(key) && "bg-sky-50 dark:bg-[rgba(0,120,212,0.05)]",
                    )}
                  >
                    {selectable ? (
                      <td className={cn("px-3", rowPadding)} onClick={(event) => event.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(key)} onChange={() => toggleSelect(key)} className="rounded border-slate-300 dark:border-[#333]" />
                      </td>
                    ) : null}
                    {activeColumns.map((column) => (
                      <td key={column.key} className={cn("px-3 text-slate-700 dark:text-[#f2f2f2]", rowPadding, column.className)}>
                        {column.render ? column.render(row) : String(cellRow[column.key] ?? "")}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </HorizontalScrollHint>
      </div>
    </div>
  );
}
