"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { useRBAC } from "@/hooks";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface PlatformVersion {
  ok: boolean;
  currentVersion?: string;
  latestVersion?: string | null;
  latestCommitSha?: string | null;
  latestRelease?: {
    tag: string;
    name: string;
    publishedAt: string;
    url: string;
  } | null;
  updateAvailable?: boolean;
  changelog?: string[];
  githubRepo?: string;
  hasGithubToken?: boolean;
  error?: string;
}

interface UpdateResult {
  ok: boolean;
  targetVersion?: string;
  manifests?: Record<string, { ok: boolean; error?: string }>;
  argocdRefreshed?: number;
  message?: string;
  errors?: string[];
  error?: string;
}

interface CiTriggerResult {
  ok: boolean;
  message?: string;
  runId?: number;
  runUrl?: string;
  error?: string;
}

interface WorkflowRunStatus {
  ok: boolean;
  status?: string;
  conclusion?: string | null;
  url?: string;
  commitMessage?: string;
  error?: string;
}

export default function PlatformUpdatePage() {
  const { isAdmin, can } = useRBAC();
  const canUpdate = isAdmin || can("cluster:admin");
  const [updateLog, setUpdateLog] = useState<string[]>([]);
  const [ciRunId, setCiRunId] = useState<number | null>(null);

  const versionQuery = useQuery({
    queryKey: ["platform", "version"],
    queryFn: () => apiClient.get<PlatformVersion>("/api/v1/platform/version"),
    staleTime: 60_000,
    retry: 1,
  });

  const ciStatusQuery = useQuery({
    queryKey: ["platform", "workflow", ciRunId],
    queryFn: () =>
      apiClient.get<WorkflowRunStatus>(`/api/v1/platform/workflow/${ciRunId}`),
    enabled: ciRunId != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status === "completed") return false;
      return 8_000; // poll every 8s while running
    },
  });

  const updateMutation = useMutation({
    mutationFn: (version?: string) =>
      apiClient.post<UpdateResult>("/api/v1/platform/update", { json: version ? { version } : {} }),
    onSuccess: (data) => {
      const lines: string[] = [];
      if (data.ok) {
        lines.push(`✅ ${data.message ?? "Update applied"}`);
        if (data.manifests) {
          lines.push("", "Manifest updates:");
          for (const [app, r] of Object.entries(data.manifests)) {
            lines.push(`  ${r.ok ? "✓" : "✗"} ${app}${r.error ? ": " + r.error : ""}`);
          }
        }
        if ((data.argocdRefreshed ?? 0) > 0) {
          lines.push("", `⟳ ArgoCD deploying — pods will restart in ~30s`);
        }
      } else {
        lines.push(`❌ ${data.error ?? "Update failed"}`);
        data.errors?.forEach((e) => lines.push(`  • ${e}`));
      }
      setUpdateLog(lines);
      versionQuery.refetch();
    },
    onError: (err: Error) => {
      setUpdateLog([`❌ Update failed: ${err.message}`]);
    },
  });

  const ciTriggerMutation = useMutation({
    mutationFn: () => apiClient.post<CiTriggerResult>("/api/v1/platform/trigger-ci", { json: {} }),
    onSuccess: (data) => {
      if (data.ok) {
        setUpdateLog([
          "🚀 GitHub Actions CI triggered",
          `Run ID: ${data.runId}`,
          data.runUrl ? `URL: ${data.runUrl}` : "",
          "",
          "CI will build images → push to ghcr.io → update manifests.",
          "When complete, click 'Apply Update' to deploy.",
        ].filter(Boolean));
        if (data.runId) setCiRunId(data.runId);
      } else {
        setUpdateLog([`❌ CI trigger failed: ${data.error}`]);
      }
    },
    onError: (err: Error) => {
      setUpdateLog([`❌ CI trigger failed: ${err.message}`]);
    },
  });

  const version = versionQuery.data;
  const current = version?.currentVersion ?? "…";
  const latest = version?.latestVersion ?? null;
  const hasUpdate = version?.updateAvailable ?? false;

  const ciRunning = ciStatusQuery.data?.status === "in_progress" || ciStatusQuery.data?.status === "queued";
  const ciDone = ciStatusQuery.data?.status === "completed";
  const ciSuccess = ciStatusQuery.data?.conclusion === "success";

  return (
    <PageScaffold title="Platform Updates" icon={ArrowUpCircle}>
      <div className="space-y-6 max-w-3xl">

        {/* Version card */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center gap-2 mb-1">
            <GitBranch className="h-4 w-4 text-slate-400" />
            <h3 className="font-semibold text-sm text-slate-100">Platform Version</h3>
            {version?.githubRepo && (
              <a
                href={version.githubRepo + "/releases"}
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
              >
                <ExternalLink className="h-3 w-3" /> GitHub releases
              </a>
            )}
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Current version vs latest GitHub release.
          </p>

          {versionQuery.isLoading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking GitHub…
            </div>
          ) : versionQuery.isError || !version?.ok ? (
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" />
              {version?.error ?? "Cannot reach GitHub API"}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Running</p>
                  <code className="font-mono text-sm text-slate-200">{current}</code>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Latest release</p>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm text-slate-200">
                      {latest ?? (version.latestCommitSha ? `main-${version.latestCommitSha}` : "—")}
                    </code>
                    {hasUpdate ? (
                      <span className="rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 text-[10px]">
                        update available
                      </span>
                    ) : latest ? (
                      <span className="rounded-full bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 text-[10px] flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> up to date
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-500/20 text-slate-400 border border-slate-500/30 px-2 py-0.5 text-[10px]">
                        no releases yet
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {version.latestRelease && (
                <div className="text-xs text-slate-500">
                  Released {new Date(version.latestRelease.publishedAt).toLocaleDateString()} ·{" "}
                  <a href={version.latestRelease.url} target="_blank" rel="noreferrer"
                    className="hover:text-slate-300 underline underline-offset-2">
                    {version.latestRelease.name || version.latestRelease.tag}
                  </a>
                </div>
              )}

              {version.changelog && version.changelog.length > 0 && (
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">What's new</p>
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

        {/* Action card */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center gap-2 mb-1">
            <ArrowUpCircle className="h-4 w-4 text-slate-400" />
            <h3 className="font-semibold text-sm text-slate-100">Apply Update</h3>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Rewrites image tags in ArgoCD manifests to the latest GitHub release version and triggers deployment.
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
              <>
                <button
                  onClick={() => updateMutation.mutate(undefined)}
                  disabled={updateMutation.isPending || !version?.ok || !hasUpdate}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                    hasUpdate
                      ? "bg-amber-500 hover:bg-amber-400 text-black"
                      : "border border-white/10 bg-white/[0.04] hover:bg-white/10 text-slate-400 cursor-not-allowed"
                  )}
                >
                  {updateMutation.isPending ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…</>
                  ) : (
                    <><ArrowUpCircle className="h-3.5 w-3.5" /> Apply Update</>
                  )}
                </button>

                {version?.hasGithubToken && (
                  <button
                    onClick={() => ciTriggerMutation.mutate()}
                    disabled={ciTriggerMutation.isPending || ciRunning}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04]
                               hover:bg-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors disabled:opacity-50"
                  >
                    {ciRunning ? (
                      <><Loader2 className="h-3.5 w-3.5 animate-spin" /> CI running…</>
                    ) : (
                      <><Play className="h-3.5 w-3.5" /> Trigger CI Build</>
                    )}
                  </button>
                )}
              </>
            )}

            {!canUpdate && (
              <p className="text-xs text-slate-500 self-center">
                Requires <code className="text-slate-300">admin</code> role.
              </p>
            )}
          </div>

          {/* CI run status */}
          {ciRunId && (
            <div className="mb-4 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3 flex items-center gap-3">
              {ciRunning && <Loader2 className="h-4 w-4 animate-spin text-blue-400 shrink-0" />}
              {ciDone && ciSuccess && <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />}
              {ciDone && !ciSuccess && <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />}
              <div className="text-xs">
                <span className="text-slate-300">
                  {ciRunning ? "CI build in progress…" : ciSuccess ? "CI build succeeded" : "CI build finished"}
                </span>
                {ciStatusQuery.data?.url && (
                  <a href={ciStatusQuery.data.url} target="_blank" rel="noreferrer"
                    className="ml-2 text-slate-500 hover:text-slate-300 underline underline-offset-2">
                    view on GitHub
                  </a>
                )}
              </div>
            </div>
          )}

          {updateLog.length > 0 && (
            <div className="rounded-lg bg-black/60 border border-white/5 p-4">
              <div className="flex items-center gap-2 text-slate-500 text-[10px] uppercase tracking-widest mb-3">
                <Terminal className="h-3 w-3" /> Output
              </div>
              <div className="font-mono text-xs text-green-400 space-y-0.5">
                {updateLog.map((line, i) => (
                  <div key={i} className="whitespace-pre">{line || "\u00a0"}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* How it works */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <h3 className="font-semibold text-sm text-slate-200 mb-3">How updates work</h3>
          <div className="space-y-2 text-xs text-slate-400">
            <p>
              <span className="text-slate-200 font-medium">1. Developer pushes a version tag</span>{" "}
              (e.g. <code className="text-slate-300">git tag v1.2.0 && git push --tags</code>) to the{" "}
              <a href={version?.githubRepo} target="_blank" rel="noreferrer" className="text-slate-300 underline underline-offset-2">
                GitHub repo
              </a>.
            </p>
            <p>
              <span className="text-slate-200 font-medium">2. GitHub Actions CI</span>{" "}
              builds Docker images, pushes them to{" "}
              <code className="text-slate-300">ghcr.io/werewolf-p/…</code>, and creates a GitHub Release.
            </p>
            <p>
              <span className="text-slate-200 font-medium">3. Apply Update (this page)</span>{" "}
              rewrites the image tags in the ArgoCD manifests to the new release version. ArgoCD then
              pulls the updated images and rolls out the new pods automatically.
            </p>
            {!version?.hasGithubToken && (
              <p className="mt-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-yellow-400/80">
                ⚠️ <span className="font-medium">GITHUB_TOKEN not configured.</span>{" "}
                The "Trigger CI Build" button is disabled. To enable it, add a GitHub PAT to the{" "}
                <code>infraweaver-console-secret</code> Kubernetes secret under key{" "}
                <code>github-token</code>.
              </p>
            )}
          </div>
        </div>
      </div>
    </PageScaffold>
  );
}
