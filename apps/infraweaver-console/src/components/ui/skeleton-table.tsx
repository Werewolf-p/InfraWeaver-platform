"use client";

import { cn } from "@/lib/utils";

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function SkeletonTable({ rows = 5, columns = 4, className }: SkeletonTableProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] shadow-sm",
        className,
      )}
    >
      <div
        className="grid gap-3 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-raised))] px-4 py-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <div key={`header-${index}`} className="h-3 rounded-md shimmer-bg" />
        ))}
      </div>
      <div className="divide-y divide-[rgb(var(--color-border))]">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={`row-${rowIndex}`}
            className="grid gap-3 px-4 py-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((__, columnIndex) => (
              <div
                key={`cell-${rowIndex}-${columnIndex}`}
                className="h-4 rounded-md shimmer-bg"
                style={{ opacity: 1 - rowIndex * 0.08 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
