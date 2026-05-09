"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { History, CheckCircle2, XCircle, Loader2, RefreshCw, GitCommit, Clock } from "lucide-react";
import { cn, timeAgo, formatDate } from "@/lib/utils";
import { useSettingsContext } from "@/contexts/settings-context";

interface ArgoEvent {
  appName: string;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  revision?: string;
}

function PhaseIcon({ phase }: { phase: string }) {
  if (phase === "Succeeded") return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (phase === "Failed" || phase === "Error") return <XCircle className="w-4 h-4 text-red-400" />;
  if (phase === "Running") return <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />;
  return <Clock className="w-4 h-4 text-slate-400" />;
}

function phaseBadge(phase: string) {
  if (phase === "Succeeded") return "bg-green-500/10 text-green-400 border-green-500/20";
  if (phase === "Failed" || phase === "Error") return "bg-red-500/10 text-red-400 border-red-500/20";
  if (phase === "Running") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  return "bg-slate-500/10 text-slate-400 border-slate-500/20";
}

export default function EventsPage() {
  const { settings } = useSettingsContext();
  const { data: events, isLoading, refetch } = useQuery<ArgoEvent[]>({
    queryKey: ["argocd", "events"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/events");
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
    refetchInterval: settings.refreshInterval,
    staleTime: 15000,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <History className="w-5 h-5 text-slate-400" />
            Activity Log
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">Recent ArgoCD sync operations</p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : events && events.length > 0 ? (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-5 top-6 bottom-6 w-px bg-white/5" />

          <div className="space-y-3">
            {events.map((event, i) => (
              <motion.div
                key={`${event.appName}-${event.startedAt}`}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className="relative flex gap-4"
              >
                {/* Timeline dot */}
                <div className={cn(
                  "relative z-10 w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border",
                  event.phase === "Succeeded" ? "bg-green-500/10 border-green-500/20"
                    : event.phase === "Failed" || event.phase === "Error" ? "bg-red-500/10 border-red-500/20"
                    : event.phase === "Running" ? "bg-yellow-500/10 border-yellow-500/20"
                    : "bg-slate-500/10 border-slate-500/20"
                )}>
                  <PhaseIcon phase={event.phase} />
                </div>

                {/* Content */}
                <div className="flex-1 bg-white/5 border border-white/10 rounded-xl p-4 hover:bg-white/[0.07] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white">{event.appName}</span>
                        <span className={cn("text-xs px-2 py-0.5 rounded-full border font-medium", phaseBadge(event.phase))}>
                          {event.phase}
                        </span>
                        {event.revision && (
                          <span className="flex items-center gap-1 text-xs text-slate-500 font-mono">
                            <GitCommit className="w-3 h-3" />
                            {event.revision.slice(0, 7)}
                          </span>
                        )}
                      </div>
                      {event.message && (
                        <p className="text-xs text-slate-400 mt-1 truncate">{event.message}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-slate-400">
                        {timeAgo(event.finishedAt ?? event.startedAt)}
                      </p>
                      <p className="text-[10px] text-slate-600 mt-0.5">
                        {formatDate(event.startedAt)}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <History className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">No recent events found</p>
        </div>
      )}
    </div>
  );
}
