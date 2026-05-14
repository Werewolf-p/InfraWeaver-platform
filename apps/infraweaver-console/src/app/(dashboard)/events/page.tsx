"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { RefreshCw, History, CheckCircle2, XCircle, Loader2, Clock, GitCommit, Activity} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";

interface K8sEvent {
  name: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  count: number;
  lastTimestamp: string;
  involvedObject: { kind: string; name: string };
}

interface ArgoEvent {
  appName: string;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  revision?: string;
}

type Tab = "k8s" | "argocd";

function phaseBadge(phase: string) {
  if (phase === "Succeeded") return "bg-green-500/10 text-green-400 border-green-500/20";
  if (phase === "Failed" || phase === "Error") return "bg-red-500/10 text-red-400 border-red-500/20";
  if (phase === "Running") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  return "bg-slate-500/10 text-slate-400 border-slate-500/20";
}

function PhaseIcon({ phase }: { phase: string }) {
  if (phase === "Succeeded") return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (phase === "Failed" || phase === "Error") return <XCircle className="w-4 h-4 text-red-400" />;
  if (phase === "Running") return <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />;
  return <Clock className="w-4 h-4 text-slate-400" />;
}

export default function EventsPage() {
  const [tab, setTab] = useState<Tab>("k8s");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: k8sData, isLoading: k8sLoading, refetch: refetchK8s, dataUpdatedAt: k8sUpdatedAt } = useQuery({
    queryKey: ["k8s-events"],
    queryFn: async () => {
      const res = await fetch("/api/events");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ events: K8sEvent[]; live: boolean }>;
    },
    refetchInterval: 30000,
    enabled: tab === "k8s",
  });

  const { data: argoData, isLoading: argoLoading, refetch: refetchArgo, dataUpdatedAt: argoUpdatedAt } = useQuery({
    queryKey: ["argocd", "events"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/events");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<ArgoEvent[]>;
    },
    refetchInterval: 30000,
    enabled: tab === "argocd",
  });

  const handleRefetch = useCallback(() => {
    if (tab === "k8s") void refetchK8s();
    else void refetchArgo();
  }, [tab, refetchK8s, refetchArgo]);

  const k8sEvents = (k8sData?.events ?? []).filter(e => {
    const matchesSearch = !search || e.reason.toLowerCase().includes(search.toLowerCase()) || e.message.toLowerCase().includes(search.toLowerCase()) || e.namespace.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || e.type.toLowerCase() === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const argoEvents = (Array.isArray(argoData) ? argoData : []).filter(e => {
    const matchesSearch = !search || e.appName.toLowerCase().includes(search.toLowerCase()) || (e.phase ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || (e.phase ?? "").toLowerCase() === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const isLoading = tab === "k8s" ? k8sLoading : argoLoading;

  return (
    <div className="space-y-6">
      <PageHeader icon={Activity} title="Activity Log" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><History className="w-5 h-5 text-slate-400" />Event Correlation</h2>
          <p className="text-sm text-slate-400">K8s and ArgoCD events in one view</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshCountdown intervalSeconds={30} resetKey={tab === "k8s" ? k8sUpdatedAt : argoUpdatedAt} />
          <button onClick={handleRefetch} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { setTab("k8s"); setStatusFilter("all"); }} className={cn("px-4 py-2 rounded-lg text-sm font-medium border transition-colors", tab === "k8s" ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300" : "bg-white/5 border-white/10 text-slate-400 hover:text-white")}>
          K8s Events
        </button>
        <button onClick={() => { setTab("argocd"); setStatusFilter("all"); }} className={cn("px-4 py-2 rounded-lg text-sm font-medium border transition-colors", tab === "argocd" ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300" : "bg-white/5 border-white/10 text-slate-400 hover:text-white")}>
          ArgoCD Events
        </button>
        {(tab === "k8s" ? ["all", "warning", "normal"] : ["all", "succeeded", "running", "failed", "error"]).map((value) => (
          <button
            key={value}
            onClick={() => setStatusFilter(value)}
            className={cn("rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors", statusFilter === value ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-300" : "border-white/10 bg-white/5 text-slate-400 hover:text-white")}
          >
            {value}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="ml-auto w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50 sm:w-48" />
      </div>

      {isLoading ? (
        <div className="space-y-3">{[...Array(6)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>
      ) : tab === "k8s" ? (
        <div className="space-y-2">
          {k8sEvents.length === 0 && <div className="py-16 text-center text-slate-500 text-sm">No events found</div>}
          {k8sEvents.map((e, i) => (
            <motion.div key={`${e.name}-${i}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
              className={cn("p-3 rounded-xl border", e.type === "Warning" ? "bg-yellow-500/5 border-yellow-500/20" : "bg-white/5 border-white/10")}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", e.type === "Warning" ? "bg-yellow-500/10 text-yellow-400" : "bg-blue-500/10 text-blue-400")}>{e.reason}</span>
                    <span className="text-xs text-slate-500">{e.involvedObject.kind}/{e.involvedObject.name}</span>
                    <span className="text-xs text-slate-600">{e.namespace}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 truncate">{e.message}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs text-slate-500">x{e.count}</p>
                  <p className="text-[10px] text-slate-600">{e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleTimeString() : ""}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {argoEvents.length === 0 && <div className="py-16 text-center text-slate-500 text-sm">No ArgoCD events found</div>}
          {argoEvents.map((e, i) => (
            <motion.div key={`${e.appName}-${e.startedAt}`} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
              className="flex gap-4">
              <div className={cn("w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border", e.phase === "Succeeded" ? "bg-green-500/10 border-green-500/20" : e.phase === "Failed" ? "bg-red-500/10 border-red-500/20" : "bg-yellow-500/10 border-yellow-500/20")}>
                <PhaseIcon phase={e.phase} />
              </div>
              <div className="flex-1 bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{e.appName}</span>
                      <span className={cn("text-xs px-2 py-0.5 rounded-full border font-medium", phaseBadge(e.phase))}>{e.phase}</span>
                      {e.revision && <span className="flex items-center gap-1 text-xs text-slate-500 font-mono"><GitCommit className="w-3 h-3" />{e.revision.slice(0, 7)}</span>}
                    </div>
                    {e.message && <p className="text-xs text-slate-400 mt-1 truncate">{e.message}</p>}
                  </div>
                  <p className="text-xs text-slate-400 flex-shrink-0">{timeAgo(e.finishedAt ?? e.startedAt)}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
