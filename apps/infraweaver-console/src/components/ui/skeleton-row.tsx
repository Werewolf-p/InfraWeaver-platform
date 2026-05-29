import { cn } from "@/lib/utils";

function Pulse({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("rounded bg-gray-50 dark:bg-[#1e1e1e] shimmer-bg", className)} />;
}

export function SkeletonRow({ columns = 4 }: { columns?: number }) {
  return (
    <div className="grid gap-3 border-b border-gray-200 dark:border-[#2a2a2a] px-4 py-3 last:border-b-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {Array.from({ length: columns }).map((_, i) => <Pulse key={i} className="h-4" />)}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 space-y-3", className)}>
      <div className="flex items-center gap-3">
        <Pulse className="h-9 w-9 rounded-lg flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <Pulse className="h-3.5 w-28" />
          <Pulse className="h-3 w-16" />
        </div>
      </div>
      <Pulse className="h-3 w-full" />
      <Pulse className="h-3 w-4/5" />
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]">
      <div className="grid gap-3 border-b border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] px-4 py-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }).map((_, i) => <Pulse key={i} className="h-3 w-20" />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => <SkeletonRow key={r} columns={columns} />)}
    </div>
  );
}
