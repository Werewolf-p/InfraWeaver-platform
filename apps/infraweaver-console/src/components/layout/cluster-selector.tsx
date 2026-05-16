"use client";
import { useRef, useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Server, Globe, CheckCircle2, AlertCircle, Loader2, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCluster, type ActiveClusterId, type ClusterInfo } from "@/contexts/cluster-context";
import { springs } from "@/lib/spring";

function StatusDot({ status }: { status: ClusterInfo["status"] | "all" }) {
  if (status === "all") return <Globe className="h-3 w-3 text-[#60a5fa]" />;
  if (status === "healthy") return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
  if (status === "degraded") return <AlertCircle className="h-3 w-3 text-amber-400" />;
  if (status === "offline") return <WifiOff className="h-3 w-3 text-red-400" />;
  return <span className="h-2 w-2 rounded-full bg-[#555]" />;
}

export function ClusterSelector({ popupDirection = "down" }: { popupDirection?: "up" | "down" }) {
  const { clusters, activeId, setActiveId, isLoading } = useCluster();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activeClusterInfo = clusters.find((c) => c.id === activeId);
  const activeLabel = activeId === "all" ? "All Clusters" : (activeClusterInfo?.name ?? activeId);
  const activeStatus = activeId === "all" ? "all" : (activeClusterInfo?.status ?? "unknown");
  const hasMultiple = clusters.length > 1;
  const popupOffset = popupDirection === "up" ? 4 : -4;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
          open
            ? "border-[#3b82f6]/50 bg-[#3b82f6]/10 text-[#7cb9ff]"
            : "border-[#2a2a2a] bg-[#1a1a1a] text-[#9e9e9e] hover:border-[#444] hover:text-[#f2f2f2]",
        )}
        title="Switch active cluster"
      >
        {isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <StatusDot status={activeStatus as ClusterInfo["status"] | "all"} />
        )}
        <span className="max-w-[90px] truncate">{activeLabel}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: popupOffset }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: popupOffset }}
            transition={springs.snappy}
            className={cn(
              "absolute right-0 z-50 w-56 overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] shadow-2xl",
              popupDirection === "up" ? "bottom-full mb-1" : "top-full mt-1",
            )}
          >
            <div className="px-3 pb-1 pt-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-[#555]">Active Cluster</p>
            </div>

            {/* Individual clusters */}
            <div className="space-y-0.5 px-1.5 pb-1.5">
              {clusters.map((cluster) => (
                <ClusterOption
                  key={cluster.id}
                  id={cluster.id}
                  label={cluster.name}
                  description={cluster.isLocal ? "Console host" : cluster.description}
                  status={cluster.status}
                  active={activeId === cluster.id}
                  onSelect={(id) => { setActiveId(id); setOpen(false); }}
                />
              ))}
            </div>

            {/* Show All option — only makes sense if multiple clusters */}
            {hasMultiple && (
              <>
                <div className="mx-3 border-t border-[#222]" />
                <div className="px-1.5 py-1.5">
                  <ClusterOption
                    id="all"
                    label="All Clusters"
                    description="Aggregate view"
                    status="all"
                    active={activeId === "all"}
                    onSelect={(id) => { setActiveId(id as ActiveClusterId); setOpen(false); }}
                  />
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ClusterOption({
  id, label, description, status, active, onSelect,
}: {
  id: string;
  label: string;
  description: string;
  status: ClusterInfo["status"] | "all";
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(id)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
        active
          ? "bg-[#3b82f6]/15 text-[#f2f2f2]"
          : "text-[#ccc] hover:bg-[#2a2a2a] hover:text-[#f2f2f2]",
      )}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#111]">
        {status === "all" ? <Globe className="h-3.5 w-3.5 text-[#60a5fa]" /> : <Server className="h-3.5 w-3.5 text-[#60a5fa]" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{label}</p>
        <p className="truncate text-[10px] text-[#555]">{description}</p>
      </div>
      <StatusDot status={status} />
    </button>
  );
}
