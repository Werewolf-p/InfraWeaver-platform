"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, Box, GitBranch, Shield, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { ResponsiveContainer, Treemap, Tooltip } from "recharts";
import { LogStreamViewer } from "@/components/logs/log-stream-viewer";
import { PageHeader } from "@/components/ui/page-header";
import { SectionTabs } from "@/components/ui/section-tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { resolveRoleDefinition, scopeLabel } from "@/lib/rbac";

interface Resource {
  kind?: string;
  name?: string;
  namespace?: string;
  status?: string;
  health?: { status?: string };
}

interface AppDetailResponse {
  application: {
    metadata?: { name?: string; namespace?: string };
    spec?: {
      project?: string;
      destination?: { namespace?: string; server?: string };
      source?: { repoURL?: string; path?: string; targetRevision?: string };
    };
    status?: {
      health?: { status?: string };
      sync?: { status?: string; revision?: string };
      reconciledAt?: string;
      summary?: { externalURLs?: string[] };
    };
  };
  resources: Resource[];
  pods: Array<{ name: string; namespace: string; status: string; containers: string[] }>;
  history: Array<{
    id: string;
    revision: string;
    deployedAt: string;
    repoURL: string;
    path: string;
    targetRevision: string;
    initiatedBy: string;
  }>;
  yaml: string;
}

interface Assignment {
  id: string;
  roleId: string;
  scope: string;
  username: string;
  userEmail: string;
  userName: string;
}

function toStatusBadge(status?: string) {
  const value = (status ?? "unknown").toLowerCase();
  if (value === "healthy") return "healthy" as const;
  if (value === "degraded") return "degraded" as const;
  if (value === "progressing") return "progressing" as const;
  if (value === "synced") return "synced" as const;
  if (value === "outofsync") return "outOfSync" as const;
  if (value === "syncing") return "syncing" as const;
  return "unknown" as const;
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function AppDetailPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params?.name ?? ""));
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedPod, setSelectedPod] = useState("");
  const [selectedContainer, setSelectedContainer] = useState("");

  const { data, isLoading, error } = useQuery<AppDetailResponse>({
    queryKey: ["app-detail", name],
    enabled: Boolean(name),
    queryFn: async () => {
      const response = await fetch(`/api/apps/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error("Failed to fetch application details");
      return response.json();
    },
  });

  const { data: assignmentsData } = useQuery<{ assignments: Assignment[] }>({
    queryKey: ["rbac-assignments", name],
    enabled: Boolean(name),
    queryFn: async () => {
      const response = await fetch("/api/rbac/assignments");
      if (!response.ok) return { assignments: [] };
      return response.json();
    },
  });

  const pods = useMemo(() => data?.pods ?? [], [data?.pods]);
  const activePodName = pods.some((pod) => pod.name === selectedPod) ? selectedPod : (pods[0]?.name ?? "");
  const selectedPodData = pods.find((pod) => pod.name === activePodName) ?? null;
  const activeContainer = selectedPodData?.containers.includes(selectedContainer)
    ? selectedContainer
    : (selectedPodData?.containers[0] ?? "");

  const treemapData = useMemo(() => {
    const grouped = (data?.resources ?? []).reduce<Record<string, { name: string; size: number }>>((accumulator, resource) => {
      const key = resource.kind ?? "Unknown";
      accumulator[key] ??= { name: key, size: 0 };
      accumulator[key].size += 1;
      return accumulator;
    }, {});

    return Object.values(grouped);
  }, [data?.resources]);

  const appPermissions = useMemo(() => {
    const appScope = `/apps/${name}`;
    return (assignmentsData?.assignments ?? []).filter((assignment) => {
      const role = resolveRoleDefinition(assignment.roleId);
      if (!role) return false;
      const canRead = role.permissions.includes("*") || role.permissions.includes("apps:read");
      if (!canRead) return false;
      return appScope.startsWith(assignment.scope) || assignment.scope === "/" || assignment.scope === "/apps" || assignment.scope === "/apps/";
    });
  }, [assignmentsData?.assignments, name]);

  if (isLoading) {
    return <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-sm text-slate-400">Loading application details...</div>;
  }

  if (error || !data) {
    return <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-300">Failed to load application details.</div>;
  }

  const app = data.application;
  const tabs = [
    { label: "Overview", value: "overview", icon: Box },
    { label: "Logs", value: "logs", icon: TerminalSquare, badge: pods.length },
    { label: "Activity", value: "activity", icon: Activity, badge: data.history.length },
    { label: "Config", value: "config", icon: GitBranch },
    { label: "Permissions", value: "permissions", icon: Shield, badge: appPermissions.length },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Box}
        title={name}
        subtitle={`${app.spec?.destination?.namespace ?? "default"} · project ${app.spec?.project ?? "platform"}`}
        breadcrumb={[{ label: "Apps", href: "/apps" }, { label: name }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={toStatusBadge(app.status?.health?.status)} />
            <StatusBadge status={toStatusBadge(app.status?.sync?.status)} />
            <Link
              href="/apps"
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </div>
        }
      />

      <SectionTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === "overview" && (
        <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Health</p>
                <div className="mt-3"><StatusBadge status={toStatusBadge(app.status?.health?.status)} /></div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Sync</p>
                <div className="mt-3"><StatusBadge status={toStatusBadge(app.status?.sync?.status)} /></div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Last sync</p>
                <p className="mt-3 text-sm text-white">{formatDate(app.status?.reconciledAt)}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Git revision</p>
                <p className="mt-3 truncate font-mono text-sm text-white">{app.status?.sync?.revision ?? app.spec?.source?.targetRevision ?? "—"}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">Resource tree map</h2>
                  <p className="text-xs text-slate-500">Visual breakdown of tracked application resources.</p>
                </div>
                <span className="text-xs text-slate-500">{data.resources.length} resources</span>
              </div>
              <div className="h-72 rounded-xl bg-slate-950/70 p-2">
                {treemapData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <Treemap data={treemapData} dataKey="size" stroke="#0f172a" fill="#6366f1">
                      <Tooltip formatter={(value) => [`${value ?? 0} resources`, "Count"]} />
                    </Treemap>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-500">No resource data available.</div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-white">Git source</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div>
                  <dt className="text-slate-500">Repository</dt>
                  <dd className="mt-1 break-all text-white">{app.spec?.source?.repoURL ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Path</dt>
                  <dd className="mt-1 font-mono text-white">{app.spec?.source?.path ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Target revision</dt>
                  <dd className="mt-1 font-mono text-white">{app.spec?.source?.targetRevision ?? "—"}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-white">Tracked resources</h2>
              <div className="mt-4 space-y-2">
                {data.resources.map((resource) => (
                  <div key={`${resource.kind}-${resource.namespace}-${resource.name}`} className="flex items-center justify-between rounded-xl border border-white/5 bg-slate-950/60 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-white">{resource.kind ?? "Unknown"}</p>
                      <p className="text-xs text-slate-500">{resource.namespace ?? app.spec?.destination?.namespace ?? "default"} / {resource.name ?? "unknown"}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {resource.health?.status ? <StatusBadge status={toStatusBadge(resource.health.status)} size="sm" /> : null}
                      {resource.status ? <StatusBadge status={toStatusBadge(resource.status)} size="sm" /> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "logs" && (
        <div className="space-y-4">
          {pods.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 p-6 text-sm text-slate-400">
              No pods were associated with this application.
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <select
                  value={activePodName}
                  onChange={(event) => {
                    const podName = event.target.value;
                    const pod = pods.find((entry) => entry.name === podName);
                    setSelectedPod(podName);
                    setSelectedContainer(pod?.containers[0] ?? "");
                  }}
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
                >
                  {pods.map((pod) => (
                    <option key={pod.name} value={pod.name}>
                      {pod.namespace} / {pod.name}
                    </option>
                  ))}
                </select>
                <select
                  value={activeContainer}
                  onChange={(event) => setSelectedContainer(event.target.value)}
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
                >
                  {(selectedPodData?.containers ?? []).map((container) => (
                    <option key={container} value={container}>{container}</option>
                  ))}
                </select>
              </div>

              <LogStreamViewer
                namespace={selectedPodData?.namespace}
                pod={selectedPodData?.name}
                container={activeContainer}
                containers={selectedPodData?.containers ?? []}
                onContainerChange={setSelectedContainer}
                emptyDescription="Select a pod from this application to inspect live logs."
              />
            </>
          )}
        </div>
      )}

      {activeTab === "activity" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
          <div className="space-y-3">
            {data.history.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-slate-950/60 px-4 py-8 text-center text-sm text-slate-500">
                No recent sync history available.
              </div>
            ) : (
              data.history.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-white/5 bg-slate-950/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">{entry.initiatedBy || "ArgoCD sync"}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(entry.deployedAt)}</p>
                    </div>
                    <StatusBadge status={toStatusBadge(app.status?.sync?.status)} size="sm" />
                  </div>
                  <dl className="mt-3 grid gap-3 text-sm md:grid-cols-3">
                    <div>
                      <dt className="text-slate-500">Revision</dt>
                      <dd className="mt-1 font-mono text-white">{entry.revision || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Path</dt>
                      <dd className="mt-1 font-mono text-white">{entry.path || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Source</dt>
                      <dd className="mt-1 break-all text-white">{entry.repoURL || "—"}</dd>
                    </div>
                  </dl>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === "config" && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950">
          <pre className="max-h-[70vh] overflow-auto p-4 text-xs leading-relaxed text-slate-200">
            <code>{data.yaml}</code>
          </pre>
        </div>
      )}

      {activeTab === "permissions" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
          <div className="space-y-3">
            {appPermissions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-slate-950/60 px-4 py-8 text-center text-sm text-slate-500">
                No app-specific RBAC assignments found. Cluster-wide roles may still apply.
              </div>
            ) : (
              appPermissions.map((assignment) => {
                const role = resolveRoleDefinition(assignment.roleId);
                return (
                  <div key={assignment.id} className="rounded-xl border border-white/5 bg-slate-950/60 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-white">{assignment.userName}</p>
                        <p className="mt-1 text-xs text-slate-500">{assignment.userEmail}</p>
                      </div>
                      <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300">
                        {role?.name ?? assignment.roleId}
                      </span>
                    </div>
                    <p className="mt-3 text-sm text-slate-400">Scope: {scopeLabel(assignment.scope)}</p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
