"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft, FileText, Logs, Server, TerminalSquare } from "lucide-react";
import { LogStreamViewer } from "@/components/logs/log-stream-viewer";
import { PageHeader } from "@/components/ui/page-header";
import { SectionTabs } from "@/components/ui/section-tabs";
import { StatusBadge } from "@/components/ui/status-badge";

interface PodDetailResponse {
  name: string;
  namespace: string;
  status: string;
  nodeName?: string;
  podIP?: string;
  createdAt?: string;
  labels: Record<string, string>;
  containers: Array<{
    name: string;
    image?: string;
    ready: boolean;
    restartCount: number;
    requests: Record<string, string>;
    limits: Record<string, string>;
  }>;
  yaml: string;
}

interface PodEventsResponse {
  events: Array<{
    name?: string;
    reason?: string;
    message?: string;
    type?: string;
    count?: number;
    lastTimestamp?: string;
  }>;
}

function toStatusBadge(status?: string) {
  const value = (status ?? "unknown").toLowerCase();
  if (value === "running") return "running" as const;
  if (value === "pending") return "pending" as const;
  if (value === "failed") return "failed" as const;
  if (value === "succeeded" || value === "completed") return "healthy" as const;
  return "unknown" as const;
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatResources(resources: Record<string, string>) {
  const entries = Object.entries(resources);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

export default function PodDetailPage() {
  const params = useParams<{ namespace: string; name: string }>();
  const namespace = decodeURIComponent(String(params?.namespace ?? ""));
  const name = decodeURIComponent(String(params?.name ?? ""));
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedContainer, setSelectedContainer] = useState("");

  const { data, isLoading, error } = useQuery<PodDetailResponse>({
    queryKey: ["pod-detail", namespace, name],
    enabled: Boolean(namespace && name),
    queryFn: async () => {
      const response = await fetch(`/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error("Failed to fetch pod details");
      return response.json();
    },
  });

  const { data: eventsData } = useQuery<PodEventsResponse>({
    queryKey: ["pod-events", namespace, name],
    enabled: activeTab === "events" && Boolean(namespace && name),
    queryFn: async () => {
      const response = await fetch(`/api/k8s/events?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error("Failed to fetch events");
      return response.json();
    },
  });

  const activeContainer = data?.containers.some((container) => container.name === selectedContainer)
    ? selectedContainer
    : (data?.containers[0]?.name ?? "");

  const selectedContainerData = useMemo(
    () => data?.containers.find((container) => container.name === activeContainer) ?? null,
    [activeContainer, data?.containers]
  );

  if (isLoading) {
    return <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-sm text-slate-400">Loading pod details...</div>;
  }

  if (error || !data) {
    return <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-300">Failed to load pod details.</div>;
  }

  const tabs = [
    { label: "Overview", value: "overview", icon: Server },
    { label: "Logs", value: "logs", icon: Logs, badge: data.containers.length },
    { label: "Terminal", value: "terminal", icon: TerminalSquare },
    { label: "Events", value: "events", icon: FileText, badge: eventsData?.events.length ?? 0 },
    { label: "Config", value: "config", icon: FileText },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title={data.name}
        subtitle={`${data.namespace} · ${data.nodeName ?? "Pending scheduling"}`}
        breadcrumb={[{ label: "Pods", href: "/pods" }, { label: `${data.namespace}/${data.name}` }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={toStatusBadge(data.status)} />
            <Link
              href="/pods"
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
        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Status</p>
                <div className="mt-3"><StatusBadge status={toStatusBadge(data.status)} /></div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Node</p>
                <p className="mt-3 text-sm text-white">{data.nodeName ?? "—"}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Pod IP</p>
                <p className="mt-3 font-mono text-sm text-white">{data.podIP ?? "—"}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Created</p>
                <p className="mt-3 text-sm text-white">{formatDate(data.createdAt)}</p>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/60">
              <div className="border-b border-white/10 px-4 py-3">
                <h2 className="text-sm font-semibold text-white">Containers</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-slate-500">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Image</th>
                      <th className="px-4 py-3 font-medium">Requests</th>
                      <th className="px-4 py-3 font-medium">Limits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.containers.map((container) => (
                      <tr key={container.name} className="border-b border-white/5 align-top last:border-b-0">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${container.ready ? "bg-emerald-400" : "bg-amber-400"}`} />
                            <div>
                              <p className="font-medium text-white">{container.name}</p>
                              <p className="text-xs text-slate-500">Restarts: {container.restartCount}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-300">{container.image ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-300">{formatResources(container.requests)}</td>
                        <td className="px-4 py-3 text-slate-300">{formatResources(container.limits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-white">Labels</h2>
              <div className="mt-4 space-y-2">
                {Object.entries(data.labels).length === 0 ? (
                  <p className="text-sm text-slate-500">No labels on this pod.</p>
                ) : (
                  Object.entries(data.labels).map(([key, value]) => (
                    <div key={key} className="rounded-xl border border-white/5 bg-slate-950/60 px-3 py-2 text-sm">
                      <p className="text-xs text-slate-500">{key}</p>
                      <p className="mt-1 break-all font-mono text-white">{value}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-white">Primary container</h2>
              <p className="mt-3 text-sm text-slate-400">{selectedContainerData?.name ?? data.containers[0]?.name ?? "—"}</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === "logs" && (
        <div className="space-y-4">
          <div className="max-w-sm">
            <select
              value={activeContainer}
              onChange={(event) => setSelectedContainer(event.target.value)}
              className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
            >
              {data.containers.map((container) => (
                <option key={container.name} value={container.name}>{container.name}</option>
              ))}
            </select>
          </div>
          <LogStreamViewer
            namespace={data.namespace}
            pod={data.name}
            container={activeContainer}
            containers={data.containers.map((container) => container.name)}
            onContainerChange={setSelectedContainer}
            emptyDescription="Select a container to inspect live pod logs."
          />
        </div>
      )}

      {activeTab === "terminal" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
          <h2 className="text-sm font-semibold text-white">Open pod shell</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Launch the read-only pod shell with this pod pre-selected. Container selection is preserved when possible.
          </p>
          <div className="mt-5">
            <Link
              href={`/pod-shell?namespace=${encodeURIComponent(data.namespace)}&pod=${encodeURIComponent(data.name)}&container=${encodeURIComponent(activeContainer || data.containers[0]?.name || "")}`}
              className="inline-flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-300 transition hover:bg-indigo-500/20"
            >
              <TerminalSquare className="h-4 w-4" />
              Open Pod Shell
            </Link>
          </div>
        </div>
      )}

      {activeTab === "events" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
          <div className="space-y-3">
            {(eventsData?.events ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-slate-950/60 px-4 py-8 text-center text-sm text-slate-500">
                No recent events for this pod.
              </div>
            ) : (
              (eventsData?.events ?? []).map((event) => (
                <div key={`${event.name}-${event.lastTimestamp}`} className="rounded-xl border border-white/5 bg-slate-950/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">{event.reason ?? "Pod event"}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(event.lastTimestamp)}</p>
                    </div>
                    <StatusBadge status={event.type === "Warning" ? "warning" : "healthy"} size="sm" />
                  </div>
                  <p className="mt-3 text-sm text-slate-300">{event.message ?? "No message"}</p>
                  <p className="mt-2 text-xs text-slate-500">Count: {event.count ?? 1}</p>
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
    </div>
  );
}
