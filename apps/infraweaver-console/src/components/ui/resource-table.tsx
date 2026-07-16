"use client";

import React, { useCallback, useMemo, useState } from "react";
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

// ---------------------------------------------------------------------------
// RowItem — memoised so toggling one checkbox doesn't re-render every row.
// ---------------------------------------------------------------------------
interface RowItemProps<T extends object> {
  row: T;
  rowKey: string;
  columns: Column<T>[];
  isSelected: boolean;
  selectable: boolean;
  hasRowClick: boolean;
  onRowClick: (() => void) | undefined;
  onToggleSelect: (key: string) => void;
}

function RowItemInner<T extends object>({
  row,
  rowKey,
  columns,
  isSelected,
  selectable,
  hasRowClick,
  onRowClick,
  onToggleSelect,
}: RowItemProps<T>) {
  const cellRow = row as Record<string, unknown>;
  return (
    <tr
      onClick={onRowClick}
      className={cn(
        "border-b border-gray-200 dark:border-[#2a2a2a] transition-colors last:border-0",
        hasRowClick && "cursor-pointer hover:bg-gray-100 dark:hover:bg-[#2a2a2a]",
        isSelected && "bg-[rgba(0,120,212,0.05)]",
      )}
    >
      {selectable && (
        <td className="px-[var(--tbl-px)] py-[var(--tbl-py)]" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(rowKey)}
            className="rounded border-gray-200 dark:border-[#333]"
          />
        </td>
      )}
      {columns.map(col => (
        <td key={col.key} className={cn("px-[var(--tbl-px)] py-[var(--tbl-py)] text-gray-900 dark:text-[#f2f2f2]", col.className)}>
          {col.render ? col.render(row) : String(cellRow[col.key] ?? "")}
        </td>
      ))}
    </tr>
  );
}

const RowItem = React.memo(RowItemInner) as typeof RowItemInner;

// ---------------------------------------------------------------------------
// ResourceTable
// ---------------------------------------------------------------------------
export function ResourceTable<T extends object>({
  columns, data, loading, empty, onRowClick, selectable, getRowKey, mobileCardRender, className,
}: ResourceTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSort = useCallback((key: string) => {
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === "asc" ? "desc" : "asc");
        return prev;
      }
      setSortDir("asc");
      return key;
    });
  }, []);

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
  }, [data, sortKey, sortDir]);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelected(new Set(sorted.map((r, i) => getRowKey ? getRowKey(r) : String(i))));
    } else {
      setSelected(new Set());
    }
  }, [sorted, getRowKey]);

  if (loading) {
    return (
      <div className={cn("space-y-2", className)}>
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 rounded bg-gray-100 dark:bg-[#2a2a2a] animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
        ))}
      </div>
    );
  }

  if (!data.length && empty) {
    return <div className={className}>{empty}</div>;
  }

  return (
    <div className={cn("w-full", className)}>
      {mobileCardRender && (
        <div className="md:hidden space-y-2">
          {sorted.map((row, i) => {
            const key = getRowKey ? getRowKey(row) : String(i);
            return (
              <div key={key} onClick={() => onRowClick?.(row)} className={cn("bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] rounded-lg p-3", onRowClick && "cursor-pointer hover:border-[#0078D4]/30")}>
                {mobileCardRender(row)}
              </div>
            );
          })}
        </div>
      )}
      <div className={cn("overflow-x-auto rounded-lg border border-gray-200 dark:border-[#2a2a2a]", mobileCardRender ? "hidden md:block" : "block")}>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-[#141414] border-b border-gray-200 dark:border-[#2a2a2a]">
              {selectable && (
                <th className="w-10 px-[var(--tbl-px)] py-[var(--tbl-py)]">
                  <input type="checkbox" className="rounded border-gray-200 dark:border-[#333]" onChange={handleSelectAll} />
                </th>
              )}
              {columns.map((col) => (
                <th key={col.key} className={cn("px-[var(--tbl-px)] py-[var(--tbl-py)] text-left text-[10px] uppercase tracking-wider font-semibold text-gray-500 dark:text-[#9e9e9e]", col.className)}>
                  {col.sortable ? (
                    <SortableHeader
                      label={col.label}
                      sortKey={col.key}
                      activeKey={sortKey}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  ) : (
                    <span>{col.label}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const key = getRowKey ? getRowKey(row) : String(i);
              return (
                <RowItem
                  key={key}
                  row={row}
                  rowKey={key}
                  columns={columns}
                  isSelected={selected.has(key)}
                  selectable={!!selectable}
                  hasRowClick={!!onRowClick}
                  onRowClick={onRowClick ? () => onRowClick(row) : undefined}
                  onToggleSelect={toggleSelect}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
