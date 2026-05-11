"use client";
import React, { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  className?: string;
  render?: (row: T) => React.ReactNode;
  mobileHide?: boolean;
}

interface ResourceTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  getRowKey?: (row: T) => string;
  mobileCardRender?: (row: T) => React.ReactNode;
  className?: string;
}

export function ResourceTable<T extends Record<string, unknown>>({
  columns, data, loading, empty, onRowClick, selectable, getRowKey, mobileCardRender, className,
}: ResourceTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey];
      if (av == null) return 1; if (bv == null) return -1;
      const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const toggleSelect = (key: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  if (loading) {
    return (
      <div className={cn("space-y-2", className)}>
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 rounded bg-[#2a2a2a] animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
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
              <div key={key} onClick={() => onRowClick?.(row)} className={cn("bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3", onRowClick && "cursor-pointer hover:border-[#0078D4]/30")}>
                {mobileCardRender(row)}
              </div>
            );
          })}
        </div>
      )}
      <div className={cn("overflow-x-auto rounded-lg border border-[#2a2a2a]", mobileCardRender ? "hidden md:block" : "block")}>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#141414] border-b border-[#2a2a2a]">
              {selectable && <th className="w-10 px-3 py-2.5"><input type="checkbox" className="rounded border-[#333]" onChange={e => setSelected(e.target.checked ? new Set(sorted.map((r, i) => getRowKey ? getRowKey(r) : String(i))) : new Set())} /></th>}
              {columns.map(col => (
                <th key={col.key} className={cn("px-3 py-2.5 text-left text-[10px] text-[#9e9e9e] uppercase tracking-wider font-semibold", col.sortable && "cursor-pointer hover:text-[#f2f2f2]", col.className)} onClick={() => col.sortable && handleSort(col.key)}>
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && (
                      sortKey === col.key
                        ? sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                        : <ChevronsUpDown className="w-3 h-3 opacity-40" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const key = getRowKey ? getRowKey(row) : String(i);
              return (
                <tr key={key}
                  onClick={() => onRowClick?.(row)}
                  className={cn("border-b border-[#2a2a2a] transition-colors last:border-0", onRowClick && "cursor-pointer hover:bg-[#2a2a2a]", selected.has(key) && "bg-[rgba(0,120,212,0.05)]")}
                >
                  {selectable && <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected.has(key)} onChange={() => toggleSelect(key)} className="rounded border-[#333]" /></td>}
                  {columns.map(col => (
                    <td key={col.key} className={cn("px-3 py-2.5 text-[#f2f2f2]", col.className)}>
                      {col.render ? col.render(row) : String(row[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
