"use client";

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SortableHeaderProps {
  label: string;
  sortKey: string;
  activeKey?: string | null;
  direction?: "asc" | "desc";
  onSort: (sortKey: string) => void;
  className?: string;
}

export function SortableHeader({ label, sortKey, activeKey, direction = "asc", onSort, className }: SortableHeaderProps) {
  const isActive = activeKey === sortKey;

  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn("inline-flex items-center gap-1 text-left transition-colors hover:text-[#f2f2f2]", className)}
    >
      <span>{label}</span>
      {isActive ? (
        direction === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );
}
