"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  GitBranch,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { useRBAC } from "@/hooks";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface PlatformVersion {
  ok: boolean;
  currentSha?: string;
  remoteSha?: string;
  branch?: string;
  updateAvailable?: boolean;
  pendingCommits?: number;
  changelog?: string[];
  error?: string;
}

interface UpdateResult {
  ok: boolean;
  updated?: boolean;
  oldSha?: string;
  newSha?: string;
  initRebuilt?: boolean;
  changelog?: string[];
  message?: string;
  error?: string;
}

export default function PlatformUpdatePage() {
  const { isAdmin, can } = useRBAC();
  const canUpdate = isAdmin || can("cluster:admin");
  const [updateLog, setUpdateLog] = useState<string[]>([]);

  const versionQuery = useQuery({
    queryKey: ["platform", "version"],
    queryFn: () => apiClient.get<PlatformVersion>("/api/v1/platform/version"),
    staleTime: 60_000,
    retry: 1,
  });

  const updateMutation = useMutation({
    mutationFn: () => apiClient.post<UpdateResult>("/api/v1/platform/update", {}),
    onSuccess: (data) => {
      const lines: string[] = [];
      if (data.updated) {
        lines.push(`✅ Updated: ${data.oldSha?.slice(0, 8)} → ${data.newSha?.slice(0, 8)}`);
        if (data.initRebuilt) lines.push("�� Init site rebuilt");
        if (data.changelog?.length) {
          lines.push("", "Commits applied:");
          data.changelog.forEach((c) => lines.push(`  ${c}`));
        }
        lines.push("", "⟳ Platform restarting — refresh in a few seconds.");
      } else if (data.message) {
        lines.push(`ℹ️ ${data.message}`);
      } else if (!data.ok && data.error) {
        lines.push(`❌ ${data.error}`);
      }
      setUpdateLog(lines);
      versionQuery.refetch();
    },
    onError: (err: Error) => {
      setUpdateLog([`❌ Update failed: ${err.message}`]);
    },
  });

  const version = versionQuery.data;
  const sha = version?.currentSha?.slice(0, 8) ?? "…";
  const remote = version?.remoteSha?.slice(0, 8) ?? "…";

  return (
    <PageScaffold title="Platform Updates" icon={ArrowUpCircle}>
      <div className="space-y-6 max-w-3xl">

        {/* Version card */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center gap-2 mb-1">
            <GitBranch className="h-4 w-4 text-slate-400" />
            <h3 className="font-semibold text-sm text-slate-100">Platform Version</h3>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Current git commit on the init VM vs latest on Onedev.
          </p>

          {versionQuery.isLoading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking version…
            </div>
          ) : versionQuery.isError || !version?.ok ? (
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" />
              {version?.error ?? "Cannot reach init VM"}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Deployed</p>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm text-slate-200">{sha}</code>
                    {version.branch && (
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400">
                        {version.branch}
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Latest (Onedev)</p>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm text-slate-200">{remote}</code>
                    {version.updateAvailable ? (
                      <span className="rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 text-[10px]">
                        {version.pendingCommits} update{version.pendingCommits !== 1 ? "s" : ""} available
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 text-[10px] flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Up to date
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {version.changelog && version.changelog.length > 0 && (
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Pending commits</p>
                  <ul className="space-y-1">
                    {version.changelog.map((c, i) => (
                      <li key={i} className="font-mono text-xs text-slate-300">{c}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Update action card */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center gap-2 mb-1">
            <ArrowUpCircle className="h-4 w-4 text-slate-400" />
            <h3 className="font-semibold text-sm text-slate-100">Apply Platform Update</h3>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Pulls latest scripts and init site from Onedev. Kubernetes apps update
            automatically via ArgoCD when new image tags are committed by CI.
          </p>

          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={() => versionQuery.refetch()}
              disabled={versionQuery.isFetching}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04]
                         hover:bg-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", versionQuery.isFetching && "animate-spin")} />
              Check for Updates
            </button>

            {canUpdate && (
              <button
                onClick={() => updateMutation.mutate()}
                disabled={updateMutation.isPending || !version?.ok}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                  version?.updateAvailable
                    ? "bg-amber-500 hover:bg-amber-400 text-black"
                    : "border border-white/10 bg-white/[0.04] hover:bg-white/10 text-slate-300"
                )}
              >
                {updateMutation.isPending ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…</>
                ) : version?.updateAvailable ? (
                  <><ArrowUpCircle className="h-3.5 w-3.5" /> Apply Update</>
                ) : (
                  <><CheckCircle2 className="h-3.5 w-3.5" /> Force Refresh</>
                )}
              </button>
            )}

            {!canUpdate && (
              <p className="text-xs text-slate-500 mt-1 self-center">
                Applying updates requires the <code className="text-slate-300">admin</code> role.
              </p>
            )}
          </div>

          {updateLog.length > 0 && (
            <div className="rounded-lg bg-black/60 border border-white/5 p-4">
              <div className="flex items-center gap-2 text-slate-500 text-[10px] uppercase tracking-widest mb-3">
                <Terminal className="h-3 w-3" />
                Update output
              </div>
              <div className="font-mono text-xs text-green-400 space-y-0.5">
                {updateLog.map((line, i) => (
                  <div key={i} className="whitespace-pre">{line || "\u00a0"}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Info card */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <h3 className="font-semibold text-sm text-slate-200 mb-3">How Platform Updates Work</h3>
          <div className="space-y-2 text-xs text-slate-400">
            <p>
              <span className="text-slate-200 font-medium">Developer pushes code</span> → Onedev CI builds
              new images (<code className="text-slate-300">infraweaver-api</code>,{" "}
              <code className="text-slate-300">infraweaver-console</code>,{" "}
              <code className="text-slate-300">infraweaver-node</code>) and commits updated image tags.
            </p>
            <p>
              <span className="text-slate-200 font-medium">ArgoCD auto-deploys</span> the new Kubernetes
              workloads when the manifest image tags change — no manual action required.
            </p>
            <p>
              <span className="text-slate-200 font-medium">Apply Update</span> (this page) pulls the latest
              scripts and init site onto the init VM. Use it to get the latest deploy tooling and setup wizard.
            </p>
          </div>
        </div>
      </div>
    </PageScaffold>
  );
}
