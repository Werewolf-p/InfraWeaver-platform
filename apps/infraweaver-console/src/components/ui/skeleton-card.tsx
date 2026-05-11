import { cn } from "@/lib/utils";

function Pulse({ className }: { className?: string }) {
  return <div className={cn("animate-pulse bg-[#2a2a2a] rounded", className)} />;
}

export function AppCardSkeleton() {
  return (
    <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-2 flex-1 mr-3">
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
    <tr className="border-b border-white/5">
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
    <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 flex items-center gap-3">
      <Pulse className="w-8 h-8 rounded-lg flex-shrink-0" />
      <div className="space-y-2 flex-1">
        <Pulse className="h-3 w-16" />
        <Pulse className="h-4 w-12" />
      </div>
    </div>
  );
}

export function TableRowSkeleton() {
  return (
    <tr className="border-b border-[#1e1e1e]">
      <td className="py-2.5 px-3"><Pulse className="h-4 w-32" /></td>
      <td className="py-2.5 px-3"><Pulse className="h-4 w-20" /></td>
      <td className="py-2.5 px-3"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="py-2.5 px-3"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="py-2.5 px-3"><Pulse className="h-5 w-14 rounded-full" /></td>
      <td className="py-2.5 px-3"><Pulse className="h-4 w-24" /></td>
      <td className="py-2.5 px-3 text-right"><div className="flex justify-end gap-2"><Pulse className="h-7 w-12 rounded" /><Pulse className="h-7 w-14 rounded" /></div></td>
    </tr>
  );
}
