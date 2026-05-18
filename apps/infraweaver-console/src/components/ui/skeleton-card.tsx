import { cn } from "@/lib/utils";

function Pulse({ className }: { className?: string }) {
  return <div className={cn("rounded bg-white dark:bg-[#1a1a1a] shimmer-bg", className)} />;
}

export function AppCardSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
      <div className="flex items-start justify-between">
        <div className="mr-3 flex-1 space-y-2">
          <Pulse className="h-4 w-32" />
          <Pulse className="h-3 w-20" />
        </div>
        <Pulse className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex gap-2">
        <Pulse className="h-5 w-16 rounded-full" />
        <Pulse className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex gap-2">
        <Pulse className="h-9 flex-1 rounded-lg" />
        <Pulse className="h-9 flex-1 rounded-lg" />
      </div>
    </div>
  );
}

export function PodRowSkeleton() {
  return (
    <tr className="border-b border-gray-200 dark:border-[#2a2a2a] last:border-b-0">
      <td className="px-4 py-3"><Pulse className="h-4 w-40" /></td>
      <td className="px-4 py-3"><Pulse className="h-4 w-24" /></td>
      <td className="px-4 py-3"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="px-4 py-3"><Pulse className="h-4 w-16" /></td>
      <td className="px-4 py-3"><Pulse className="h-4 w-12" /></td>
    </tr>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
      <Pulse className="h-8 w-8 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Pulse className="h-3 w-16" />
        <Pulse className="h-4 w-12" />
      </div>
    </div>
  );
}

export function TableRowSkeleton() {
  return (
    <tr className="border-b border-gray-200 dark:border-[#2a2a2a] last:border-b-0">
      <td className="px-3 py-2.5"><Pulse className="h-4 w-32" /></td>
      <td className="px-3 py-2.5"><Pulse className="h-4 w-20" /></td>
      <td className="px-3 py-2.5"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="px-3 py-2.5"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="px-3 py-2.5"><Pulse className="h-5 w-14 rounded-full" /></td>
      <td className="px-3 py-2.5"><Pulse className="h-4 w-24" /></td>
      <td className="px-3 py-2.5 text-right"><div className="flex justify-end gap-2"><Pulse className="h-7 w-12 rounded" /><Pulse className="h-7 w-14 rounded" /></div></td>
    </tr>
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]">
      <div className="border-b border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] px-4 py-3">
        <Pulse className="h-4 w-32" />
      </div>
      <div className="divide-y divide-[#2a2a2a]">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="grid gap-3 px-4 py-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {Array.from({ length: columns }).map((__, columnIndex) => (
              <Pulse key={columnIndex} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
