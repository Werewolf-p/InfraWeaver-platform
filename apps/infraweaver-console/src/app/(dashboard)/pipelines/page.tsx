"use client";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { GitBranch, Play, RefreshCw, CheckCircle2, XCircle, Clock, Loader2, AlertCircle, ChevronRight } from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import Link from "next/link";

interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
  lastRunId: number | null;
  lastRunStatus: string | null;
  lastRunConclusion: string | null;
  lastRunAt: string | null;
  lastRunBranch: string | null;
  durationSec: number | null;
}

function conclusionIcon(status: string | null, conclusion: string | null) {
  if (status === "in_progress" || status === "queued") return <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />;
  if (conclusion === "success") return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  if (conclusion === "failure") return <XCircle className="w-4 h-4 text-red-400" />;
  if (conclusion === "cancelled") return <AlertCircle className="w-4 h-4 text-slate-400" />;
  return <Clock className="w-4 h-4 text-slate-500" />;
}

function conclusionColor(conclusion: string | null): string {
  if (conclusion === "success") return "border-emerald-500/20 bg-emerald-500/5";
  if (conclusion === "failure") return "border-red-500/20 bg-red-500/5";
  return "border-white/10 bg-white/5";
}

function formatDuration(sec: number | null): string {
  if (sec === null || sec < 0) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export default function PipelinesPage() {
  const { isAdmin } = useRBAC();
  const qc = useQueryClient();
  const [triggering, setTriggering] = useState<number | null>(null);
  const [confirmWorkflow, setConfirmWorkflow] = useState<Workflow | null>(null);

  const { data, isLoading, refetch } = useQuery<{ workflows: Workflow[] }>({
    queryKey: ["pipelines", "workflows"],
    queryFn: async () => {
      const res = await fetch("/api/pipelines");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const workflows = data?.workflows ?? [];

  const handleTrigger = async (wf: Workflow) => {
    setConfirmWorkflow(null);
    setTriggering(wf.id);
    try {
      const res = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: wf.id, ref: wf.lastRunBranch ?? "main" }),
      });
      if (!res.ok) throw new Error("Trigger failed");
      toast.success(`Triggered: ${wf.name}`);
      setTimeout(() => { void qc.invalidateQueries({ queryKey: ["pipelines"] }); }, 3000);
    } catch {
      toast.error(`Failed to trigger ${wf.name}`);
    } finally {
      setTriggering(null);
    }
  };

  const successCount = workflows.filter(w => w.lastRunConclusion === "success").length;
  const failCount = workflows.filter(w => w.lastRunConclusion === "failure").length;
  const runningCount = workflows.filter(w => w.lastRunStatus === "in_progress").length;

  return (
    <div>
      <div className="relative rounded-xl overflow-hidden mb-6">
        <div className="absolute inset-0 page-gradient-cluster pointer-events-none" />
        <div className="relative flex items-start justify-between p-5 gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
              <GitBranch className="w-5 h-5 text-indigo-400" />
              CI/CD Pipelines
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">GitHub Actions workflows for the InfraWeaver platform</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/cluster" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors">
              ← Cluster
            </Link>
            <button onClick={() => { void refetch(); }} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors active:scale-95">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Passing", value: successCount, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
          { label: "Failing", value: failCount, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
          { label: "Running", value: runningCount, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
        ].map(s => (
          <div key={s.label} className={cn("rounded-xl border p-4 text-center", s.bg)}>
            <p className={cn("text-2xl font-bold tabular-nums", s.color)}>{s.value}</p>
            <p className="text-xs text-slate-400 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="h-24 rounded-xl shimmer-bg" />)}</div>
      ) : (
        <div className="space-y-3">
          {workflows.map((wf, i) => (
            <motion.div
              key={wf.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06 }}
              className={cn("rounded-xl border p-4 flex items-center gap-4 flex-wrap", conclusionColor(wf.lastRunConclusion))}
            >
              <div className="flex-shrink-0">{conclusionIcon(wf.lastRunStatus, wf.lastRunConclusion)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{wf.name}</p>
                <p className="text-xs text-slate-500 font-mono truncate">{wf.path}</p>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400 flex-wrap">
                {wf.lastRunBranch && (
                  <span className="flex items-center gap-1 bg-white/5 px-2 py-0.5 rounded">
                    <GitBranch className="w-3 h-3" />{wf.lastRunBranch}
                  </span>
                )}
                {wf.durationSec !== null && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />{formatDuration(wf.durationSec)}
                  </span>
                )}
                {wf.lastRunAt && (
                  <span>{timeAgo(wf.lastRunAt)}</span>
                )}
                {wf.lastRunId && (
                  <a
                    href={`https://github.com/Werewolf-p/InfraWeaver-platform/actions/runs/${wf.lastRunId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    View run <ChevronRight className="w-3 h-3" />
                  </a>
                )}
              </div>
              {isAdmin && (
                <button
                  onClick={() => setConfirmWorkflow(wf)}
                  disabled={triggering === wf.id || wf.lastRunStatus === "in_progress"}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-xs text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {triggering === wf.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  Trigger
                </button>
              )}
            </motion.div>
          ))}
          {workflows.length === 0 && (
            <div className="py-16 text-center text-slate-500">
              <GitBranch className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p>No workflows found</p>
            </div>
          )}
        </div>
      )}

      {confirmWorkflow && (
        <ConfirmDialog
          open={true}
          onConfirm={() => void handleTrigger(confirmWorkflow)}
          onCancel={() => setConfirmWorkflow(null)}
          title={`Trigger: ${confirmWorkflow.name}?`}
          description={`This will dispatch the workflow on branch "${confirmWorkflow.lastRunBranch ?? "main"}".`}
          confirmText="Trigger"
        />
      )}
    </div>
  );
}
