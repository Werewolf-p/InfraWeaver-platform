"use client";
import { CheckCircle2, AlertTriangle, WifiOff, HelpCircle, Server } from "lucide-react";
import { type ClusterInfo, useCluster } from "@/contexts/cluster-context";

function StatusIcon({ status }: { status: ClusterInfo["status"] }) {
  if (status === "healthy") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === "degraded") return <AlertTriangle className="h-4 w-4 text-amber-400" />;
  if (status === "offline") return <WifiOff className="h-4 w-4 text-red-400" />;
  return <HelpCircle className="h-4 w-4 text-[#555]" />;
}

export function ClusterSummaryCard({ cluster }: { cluster: ClusterInfo }) {
  const { setActiveId } = useCluster();
  return (
    <button
      onClick={() => setActiveId(cluster.id)}
      className="flex flex-col gap-3 rounded-xl border border-[#2a2a2a] bg-[#111] p-4 text-left transition-all hover:border-[#3b82f6]/40 hover:bg-[#161616] active:scale-[0.98]"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1a1a1a]">
            <Server className="h-4 w-4 text-[#60a5fa]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[#f2f2f2]">{cluster.name}</p>
            <p className="text-[10px] text-[#555]">{cluster.description}</p>
          </div>
        </div>
        <StatusIcon status={cluster.status} />
      </div>
      {cluster.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cluster.tags.map(tag => (
            <span key={tag} className="rounded-full bg-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#666]">{tag}</span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-[#3b82f6]">Click to manage →</p>
    </button>
  );
}
