import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse bg-white/5 rounded-lg shimmer-bg", className)} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("bg-white/5 border border-white/10 rounded-xl p-4 space-y-3", className)}>
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

export function SkeletonTableRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-white/5">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i === 0 ? "w-1/3" : "flex-1")} />
      ))}
    </div>
  );
}

export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={cn("bg-white/5 border border-white/10 rounded-xl p-5 space-y-3", className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="w-8 h-8 rounded-lg" />
      </div>
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cn("bg-white/5 border border-white/10 rounded-xl overflow-hidden", className)}>
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-white/10 bg-white/[0.02]">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3", i === 0 ? "w-1/4" : "flex-1")} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonTableRow key={i} cols={cols} />
      ))}
    </div>
  );
}
