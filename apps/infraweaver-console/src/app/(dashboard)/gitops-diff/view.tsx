"use client";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { GitBranch, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { CopyButton, EmptyState, FilterSelect } from "@/components/ui";
import { useApiQuery } from "@/hooks/use-api-query";

interface ArgoApp {
  metadata: { name: string };
  status: { health: { status: string }; sync: { status: string } };
}

interface DiffResult {
  diff?: string;
  error?: string;
}

/** OutOfSync / Degraded apps rank first — that is where remediation is needed. */
function appRank(app: ArgoApp): number {
  const outOfSync = app.status.sync.status !== "Synced";
  const unhealthy = app.status.health.status !== "Healthy";
  return (outOfSync ? 0 : 2) + (unhealthy ? 0 : 1);
}

interface DiffStat {
  added: number;
  removed: number;
  hunks: number;
}

function computeDiffStat(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) hunks += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed, hunks };
}

function lineTone(line: string): string {
  if (line.startsWith("@@")) return "text-blue-500 dark:text-blue-400 bg-blue-500/5";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-slate-500 dark:text-slate-400";
  if (line.startsWith("+")) return "text-green-600 dark:text-green-400 bg-green-500/[0.06]";
  if (line.startsWith("-")) return "text-red-500 dark:text-red-400 bg-red-500/[0.06]";
  return "text-slate-700 dark:text-slate-300";
}

export function GitopsDiffView() {
  const [selectedApp, setSelectedApp] = useState<string>("");

  const { data: appsData } = useApiQuery<ArgoApp[]>({
    queryKey: ["argocd", "apps"],
    path: "/api/argocd/apps",
  });

  const { data: diffData, isLoading } = useApiQuery<DiffResult>({
    queryKey: ["argocd", "diff", selectedApp],
    path: `/api/argocd/diff/${selectedApp}`,
    enabled: !!selectedApp,
  });

  const apps = useMemo(() => appsData ?? [], [appsData]);

  const outOfSyncCount = apps.filter((a) => a.status.sync.status !== "Synced").length;

  const appOptions = useMemo(() => {
    const sorted = [...apps].sort((a, b) => appRank(a) - appRank(b) || a.metadata.name.localeCompare(b.metadata.name));
    return [
      { value: "", label: apps.length > 0 ? "Choose an app…" : "No applications found" },
      ...sorted.map((a) => ({
        value: a.metadata.name,
        label: `${a.status.sync.status !== "Synced" ? "● " : ""}${a.metadata.name} — ${a.status.health.status} / ${a.status.sync.status}`,
      })),
    ];
  }, [apps]);

  const diffText = diffData?.diff ?? "";
  const stat = useMemo(() => (diffText ? computeDiffStat(diffText) : null), [diffText]);
  const lines = useMemo(() => (diffText ? diffText.split("\n") : []), [diffText]);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={GitBranch} title="GitOps Diff" description={`Live vs desired state per ArgoCD application${outOfSyncCount > 0 ? ` · ${outOfSyncCount} out of sync` : ""}`} />

      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4">
        <label htmlFor="gitops-app-picker" className="text-xs text-slate-500 dark:text-slate-400 mb-2 block">Select Application <span className="text-slate-400 dark:text-slate-500">(drifted apps listed first)</span></label>
        <FilterSelect id="gitops-app-picker" label="Select application" value={selectedApp} onChange={setSelectedApp} options={appOptions} className="w-full" />
      </div>

      {!selectedApp ? (
        <EmptyState icon={GitBranch} title="Select an application" description="Pick an ArgoCD app above to compare its live cluster state against the desired Git state." />
      ) : (
        <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 dark:border-white/10 px-4 py-3">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Diff: {selectedApp}</h3>
              {stat && (stat.added > 0 || stat.removed > 0) ? (
                <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                  <span className="text-green-600 dark:text-green-400">+{stat.added}</span>
                  <span className="text-red-500 dark:text-red-400">−{stat.removed}</span>
                  <span className="text-slate-500 dark:text-slate-400">{stat.hunks} hunk{stat.hunks === 1 ? "" : "s"}</span>
                </div>
              ) : null}
            </div>
            {diffText ? <CopyButton text={diffText} label="Copy diff" /> : null}
          </div>

          <div className="p-4">
            {isLoading ? (
              <div className="h-32 bg-gray-100 dark:bg-white/5 rounded-lg animate-pulse" />
            ) : diffData?.error ? (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-500 dark:text-red-400" aria-hidden="true" />
                <p className="text-sm text-red-500 dark:text-red-400">{diffData.error}</p>
              </div>
            ) : diffText ? (
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40">
                <pre className="text-xs leading-relaxed max-h-[28rem] overflow-y-auto">
                  {lines.map((line, i) => (
                    <div key={i} className={cn("grid grid-cols-[3rem_1fr] items-start", lineTone(line))}>
                      <span className="select-none px-2 py-px text-right text-slate-400 dark:text-slate-600 tabular-nums">{i + 1}</span>
                      <code className="whitespace-pre px-2 py-px">{line || " "}</code>
                    </div>
                  ))}
                </pre>
              </div>
            ) : (
              <EmptyState icon={CheckCircle2} title="In sync" description="No difference between the live cluster state and the desired Git state for this application." />
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
