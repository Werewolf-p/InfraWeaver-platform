"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Download,
  HeartPulse,
  RefreshCw,
  Server,
  Siren,
  TriangleAlert,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader } from "@/components/ui/page-header";
import { AutoRefreshControl } from "@/components/ui/auto-refresh-control";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { DashboardStatCard } from "@/components/ui/dashboard-stat-card";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { ExportButton } from "@/components/ui/export-button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedBar } from "@/components/ui/segmented-bar";
import { Tooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/ui/copy-button";
import { cn, timeAgo } from "@/lib/utils";

interface EndpointResult {
  success: boolean;
  duration: number;
  timestamp?: string;
}

interface Endpoint {
  name: string;
  results?: EndpointResult[];
}

interface SLAEntry {
  name: string;
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
}

interface SLAData {
  sla: SLAEntry[];
  overall: { uptime24h: number; uptime7d: number; uptime30d: number };
}

interface TimelinePoint {
  timestamp: string;
  status: "up" | "degraded" | "down";
  latencyMs: number;
}

interface PlatformStatus {
  status: string;
  services: Array<{ name: string; status: string; latencyMs: number }>;
  metrics: { totalNodes: number; readyNodes: number; uptime: string };
  checkedAt: string;
}

interface K8sEvent {
  name: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  count: number;
  lastTimestamp: string | null;
  involvedObject: { kind: string; name: string };
}

type TimeRange = "1h" | "6h" | "24h";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "1h": "Last 1 hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
};

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function endpointStatus(endpoint: Endpoint) {
  const current = endpoint.results?.[0];
  if (!current) return "unknown" as const;
  if (!current.success) return "down" as const;
  if ((current.duration ?? 0) >= 500) return "degraded" as const;
  return "healthy" as const;
}

function uptimePercent(results: EndpointResult[]) {
  if (!results.length) return 0;
  const ok = results.filter((result) => result.success).length;
  return Math.round((ok / results.length) * 100);
}

function shortTime(ts: string) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function AlertFeed({ events }: { events: K8sEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={Siren}
        title="No active alerts"
        description="Warnings and notable cluster events will appear here as the monitoring surfaces refresh."
        className="py-10"
      />
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <div
          key={`${event.namespace}-${event.name}-${event.lastTimestamp}`}
          className={cn(
            "rounded-2xl border p-3",
            event.type === "Warning"
              ? "border-amber-500/30 bg-amber-500/10"
              : "border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414]"
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
                    event.type === "Warning" ? "bg-amber-500/15 text-amber-200" : "bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888]"
                  )}
                >
                  {event.reason}
                </span>
                <span className="text-xs text-gray-500 dark:text-[#888]">{event.namespace}</span>
                <span className="text-xs text-gray-400 dark:text-[#666]">{event.involvedObject.kind}/{event.involvedObject.name}</span>
              </div>
              <p className="mt-2 text-sm text-gray-900 dark:text-[#f2f2f2]">{event.message}</p>
            </div>
            <div className="text-right text-xs text-gray-500 dark:text-[#888]">
              <p>x{event.count}</p>
              <p>{event.lastTimestamp ? timeAgo(event.lastTimestamp) : "now"}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MonitoringPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("6h");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30000);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !isTypingTarget) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSearch("");
        setOnlyIssues(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const healthQuery = useQuery({
    queryKey: ["monitoring", "health"],
    queryFn: async () => {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error("Failed to load endpoint health");
      return response.json() as Promise<{ endpoints: Endpoint[] }>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const slaQuery = useQuery({
    queryKey: ["monitoring", "sla"],
    queryFn: async () => {
      const response = await fetch("/api/health/sla");
      if (!response.ok) throw new Error("Failed to load SLA data");
      return response.json() as Promise<SLAData>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 30000,
  });

  const timelineQuery = useQuery({
    queryKey: ["monitoring", "timeline"],
    queryFn: async () => {
      const response = await fetch("/api/health/timeline");
      if (!response.ok) throw new Error("Failed to load timeline data");
      return response.json() as Promise<{ data: TimelinePoint[] }>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const statusQuery = useQuery({
    queryKey: ["monitoring", "platform-status"],
    queryFn: async () => {
      const response = await fetch("/api/platform/status");
      if (!response.ok) throw new Error("Failed to load platform status");
      return response.json() as Promise<PlatformStatus>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const eventsQuery = useQuery({
    queryKey: ["monitoring", "events"],
    queryFn: async () => {
      const response = await fetch("/api/events");
      if (!response.ok) throw new Error("Failed to load recent events");
      return response.json() as Promise<{ events: K8sEvent[] }>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const endpoints = useMemo(() => healthQuery.data?.endpoints ?? [], [healthQuery.data?.endpoints]);
  const slaByName = useMemo(
    () => new Map((slaQuery.data?.sla ?? []).map((entry) => [entry.name, entry])),
    [slaQuery.data?.sla],
  );

  const filteredEndpoints = useMemo(() => {
    const query = search.trim().toLowerCase();
    return endpoints.filter((endpoint) => {
      const status = endpointStatus(endpoint);
      const matchesSearch = !query || endpoint.name.toLowerCase().includes(query);
      const matchesIssues = !onlyIssues || status !== "healthy";
      return matchesSearch && matchesIssues;
    });
  }, [endpoints, onlyIssues, search]);

  const filteredTimeline = useMemo(() => {
    const data = timelineQuery.data?.data ?? [];
    const latestPointMs = data.length > 0 ? new Date(data[data.length - 1].timestamp).getTime() : 0;
    const threshold = latestPointMs - TIME_RANGE_MS[timeRange];
    return data.filter((point) => new Date(point.timestamp).getTime() >= threshold);
  }, [timeRange, timelineQuery.data?.data]);

  const chartPoints = useMemo(
    () =>
      filteredTimeline.map((point) => ({
        time: shortTime(point.timestamp),
        latencyMs: point.latencyMs,
        availability: point.status === "up" ? 100 : point.status === "degraded" ? 55 : 0,
        status: point.status,
      })),
    [filteredTimeline],
  );

  const warningEvents = useMemo(
    () => (eventsQuery.data?.events ?? []).filter((event) => event.type === "Warning").slice(0, 6),
    [eventsQuery.data?.events],
  );

  const healthyCount = filteredEndpoints.filter((endpoint) => endpointStatus(endpoint) === "healthy").length;
  const degradedCount = filteredEndpoints.filter((endpoint) => endpointStatus(endpoint) === "degraded").length;
  const downCount = filteredEndpoints.filter((endpoint) => endpointStatus(endpoint) === "down").length;
  const slowCount = filteredEndpoints.filter((endpoint) => (endpoint.results?.[0]?.duration ?? 0) >= 500).length;
  const alertCount = downCount + degradedCount + warningEvents.length;
  const avgLatency = chartPoints.length
    ? Math.round(chartPoints.reduce((sum, point) => sum + point.latencyMs, 0) / chartPoints.length)
    : 0;
  const uptimeFootprint = filteredTimeline.length
    ? Math.round((filteredTimeline.filter((point) => point.status === "up").length / filteredTimeline.length) * 100)
    : 0;

  const isPrimaryLoading = healthQuery.isLoading || timelineQuery.isLoading || statusQuery.isLoading;
  const primaryError = healthQuery.error ?? timelineQuery.error ?? statusQuery.error;

  const exportData = async (format: "csv" | "json" | "yaml") => {
    const rows = filteredEndpoints.map((endpoint) => {
      const sla = slaByName.get(endpoint.name);
      return {
        name: endpoint.name,
        status: endpointStatus(endpoint),
        currentLatencyMs: endpoint.results?.[0]?.duration ?? 0,
        uptimeRecent: uptimePercent(endpoint.results ?? []),
        uptime24h: sla?.uptime24h ?? null,
        uptime7d: sla?.uptime7d ?? null,
        uptime30d: sla?.uptime30d ?? null,
      };
    });

    if (format === "json") {
      return JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          timeRange,
          refreshInterval,
          rows,
        },
        null,
        2,
      );
    }

    const header = ["name", "status", "currentLatencyMs", "uptimeRecent", "uptime24h", "uptime7d", "uptime30d"];
    const csv = [
      header.join(","),
      ...rows.map((row) => header.map((key) => JSON.stringify(row[key as keyof typeof row] ?? "")).join(",")),
    ].join("\n");

    if (format === "yaml") {
      return rows
        .map(
          (row) =>
            `- name: ${row.name}\n  status: ${row.status}\n  currentLatencyMs: ${row.currentLatencyMs}\n  uptimeRecent: ${row.uptimeRecent}\n  uptime24h: ${row.uptime24h ?? ""}\n  uptime7d: ${row.uptime7d ?? ""}\n  uptime30d: ${row.uptime30d ?? ""}`,
        )
        .join("\n");
    }

    return csv;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={HeartPulse}
        title="Monitoring"
        subtitle="Unified observability dashboard for alerts, uptime, latency, and live platform status"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportButton getData={exportData} filename="monitoring-overview" formats={["csv", "json"]} />
            <AutoRefreshControl
              interval={refreshInterval}
              onChange={setRefreshInterval}
              onRefreshNow={() => {
                void healthQuery.refetch();
                void timelineQuery.refetch();
                void statusQuery.refetch();
                void eventsQuery.refetch();
                void slaQuery.refetch();
              }}
            />
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <DashboardStatCard
          label="Active alerts"
          value={alertCount}
          icon={Siren}
          tone={alertCount > 0 ? "danger" : "success"}
          description={
            alertCount > 0
              ? "Endpoint incidents, degraded latency, and warning events need review."
              : "No active incidents across the monitored estate."
          }
          footer={<span>{warningEvents.length} recent warning event{warningEvents.length === 1 ? "" : "s"}</span>}
        />
        <DashboardStatCard
          label="Healthy endpoints"
          value={`${healthyCount}/${filteredEndpoints.length || endpoints.length || 0}`}
          icon={Server}
          tone={downCount > 0 ? "warning" : "info"}
          description="Current endpoint health after applying your filters."
          footer={
            <span>
              {degradedCount} degraded · {downCount} down
            </span>
          }
        />
        <DashboardStatCard
          label="Latency trend"
          value={avgLatency > 0 ? `${avgLatency} ms` : "—"}
          icon={Activity}
          tone={avgLatency >= 400 ? "warning" : "neutral"}
          description={`${TIME_RANGE_LABELS[timeRange]} average response time across the monitoring timeline.`}
          footer={<span>{slowCount} endpoint{slowCount === 1 ? "" : "s"} over 500ms right now</span>}
        />
        <DashboardStatCard
          label="Availability"
          value={slaQuery.data ? `${slaQuery.data.overall.uptime24h.toFixed(2)}%` : `${uptimeFootprint}%`}
          icon={HeartPulse}
          tone={slaQuery.data && slaQuery.data.overall.uptime24h < 99 ? "warning" : "success"}
          description="24h availability target for the shared platform surface."
          footer={<span>Platform status: {statusQuery.data?.status ?? "unknown"}</span>}
        />
      </div>

      <DashboardPanel
        title="Monitoring controls"
        description="Filter services fast, keep an eye on auto-refresh cadence, and switch investigation windows without leaving the page."
        icon={RefreshCw}
        actions={<RefreshCountdown intervalSeconds={Math.max(15, Math.round((refreshInterval || 30000) / 1000))} resetKey={healthQuery.dataUpdatedAt} />}
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
            <ToolbarSearchInput
              ref={searchRef}
              value={search}
              onChange={setSearch}
              placeholder="Search monitored services, namespaces, or alert sources…"
              className="flex-1"
            />
            <button
              onClick={() => setOnlyIssues((current) => !current)}
              className={cn(
                "h-11 rounded-xl border px-4 text-sm font-medium transition-colors",
                onlyIssues
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#9e9e9e] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
              )}
            >
              Only issues
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["1h", "6h", "24h"] as TimeRange[]).map((option) => (
              <button
                key={option}
                onClick={() => setTimeRange(option)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  timeRange === option
                    ? "border-[#0078D4]/40 bg-[rgba(0,120,212,0.15)] text-[#9dcbff]"
                    : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                )}
              >
                {TIME_RANGE_LABELS[option]}
              </button>
            ))}
          </div>
        </div>
      </DashboardPanel>

      {primaryError ? (
        <DashboardPanel title="Monitoring unavailable" description="The observability APIs could not be reached right now." icon={TriangleAlert}>
          <EmptyState
            icon={TriangleAlert}
            title="Monitoring data could not be loaded"
            description={primaryError instanceof Error ? primaryError.message : "Try refreshing the dashboard."}
            action={{
              label: "Retry",
              onClick: () => {
                void healthQuery.refetch();
                void timelineQuery.refetch();
                void statusQuery.refetch();
              },
            }}
            className="py-10"
          />
        </DashboardPanel>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
        <DashboardPanel title="Latency & availability" description={`Auto-refreshing chart data for ${TIME_RANGE_LABELS[timeRange].toLowerCase()}.`} icon={Clock3}>
          {isPrimaryLoading ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="h-64 animate-pulse rounded-2xl bg-white dark:bg-[#111]" />
              ))}
            </div>
          ) : chartPoints.length === 0 ? (
            <EmptyState icon={Activity} title="No timeline data" description="Timeline points will appear once the monitoring history API returns samples." className="py-10" />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Latency trend</p>
                    <p className="text-xs text-gray-500 dark:text-[#888]">Average response time of the shared monitoring surface.</p>
                  </div>
                  <Tooltip content="Higher spikes usually indicate downstream saturation or an endpoint timeout.">
                    <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1 text-[10px] text-gray-500 dark:text-[#888]">Investigate spikes</span>
                  </Tooltip>
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartPoints}>
                      <defs>
                        <linearGradient id="monitoringLatency" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#0078D4" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#0078D4" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" />
                      <XAxis dataKey="time" tick={{ fill: "#888", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tick={{ fill: "#888", fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                      <RechartsTooltip contentStyle={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 12 }} />
                      <Area type="monotone" dataKey="latencyMs" stroke="#0078D4" fill="url(#monitoringLatency)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Availability signal</p>
                    <p className="text-xs text-gray-500 dark:text-[#888]">Up, degraded, and down transitions for the selected time range.</p>
                  </div>
                  <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1 text-[10px] text-gray-500 dark:text-[#888]">{uptimeFootprint}% stable</span>
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartPoints}>
                      <defs>
                        <linearGradient id="monitoringAvailability" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" />
                      <XAxis dataKey="time" tick={{ fill: "#888", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis domain={[0, 100]} tick={{ fill: "#888", fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                      <RechartsTooltip contentStyle={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 12 }} />
                      <Area type="stepAfter" dataKey="availability" stroke="#10b981" fill="url(#monitoringAvailability)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel title="Alert feed" description="Recent warning events plus current incident distribution." icon={AlertTriangle}>
          <div className="space-y-4">
            <div>
              <SegmentedBar
                segments={[
                  { label: "Healthy", value: healthyCount, className: "bg-emerald-500" },
                  { label: "Degraded", value: degradedCount, className: "bg-amber-500" },
                  { label: "Down", value: downCount, className: "bg-red-500" },
                ]}
              />
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-[#888]">
                <span>{healthyCount} healthy</span>
                <span>{degradedCount} degraded</span>
                <span>{downCount} down</span>
              </div>
            </div>
            <AlertFeed events={warningEvents} />
          </div>
        </DashboardPanel>
      </div>

      <DashboardPanel
        title="Service watchlist"
        description="Use this table to scan health, uptime, and latency without drilling into the lower-level pages."
        icon={HeartPulse}
        actions={<span className="text-xs text-gray-500 dark:text-[#888]">{filteredEndpoints.length} service{filteredEndpoints.length === 1 ? "" : "s"} shown</span>}
      >
        {healthQuery.isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="h-16 animate-pulse rounded-2xl bg-white dark:bg-[#111]" />
            ))}
          </div>
        ) : filteredEndpoints.length === 0 ? (
          <EmptyState
            icon={HeartPulse}
            title="No services match your filters"
            description="Clear the issue-only toggle or broaden your search to restore the monitoring watchlist."
            action={{
              label: "Reset filters",
              onClick: () => {
                setSearch("");
                setOnlyIssues(false);
              },
            }}
            className="py-10"
          />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-[#2a2a2a]">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_140px_120px_120px_130px] gap-4 border-b border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-gray-400 dark:text-[#666] lg:grid">
              <span>Service</span>
              <span>Status</span>
              <span>Latency</span>
              <span>Recent uptime</span>
              <span>24h SLA</span>
            </div>
            <div className="divide-y divide-[#2a2a2a]">
              {filteredEndpoints.map((endpoint, index) => {
                const status = endpointStatus(endpoint);
                const sla = slaByName.get(endpoint.name);
                const currentLatency = endpoint.results?.[0]?.duration ?? 0;
                const recentUptime = uptimePercent(endpoint.results ?? []);
                return (
                  <motion.div
                    key={endpoint.name}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(index * 0.03, 0.18) }}
                    className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1.4fr)_140px_120px_120px_130px] lg:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{endpoint.name}</span>
                        <CopyButton text={endpoint.name} className="h-7 px-2 text-[11px]" />
                      </div>
                      <p className="mt-1 text-xs text-gray-400 dark:text-[#666]">Last sample {endpoint.results?.[0]?.timestamp ? timeAgo(endpoint.results[0].timestamp) : "unavailable"}</p>
                    </div>
                    <div>
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-3 py-1 text-xs font-medium capitalize",
                          status === "healthy" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
                          status === "degraded" && "border-amber-500/30 bg-amber-500/10 text-amber-200",
                          status === "down" && "border-red-500/30 bg-red-500/10 text-red-200",
                          status === "unknown" && "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888]"
                        )}
                      >
                        {status}
                      </span>
                    </div>
                    <div className="text-sm text-gray-700 dark:text-[#d4d4d4]">{currentLatency > 0 ? `${currentLatency} ms` : "—"}</div>
                    <div className="text-sm text-gray-700 dark:text-[#d4d4d4]">{recentUptime}%</div>
                    <div className="text-sm text-gray-700 dark:text-[#d4d4d4]">{sla ? `${sla.uptime24h.toFixed(2)}%` : "—"}</div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}
      </DashboardPanel>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <DashboardPanel title="Platform status" description="Cross-check the monitoring layer against live control plane status." icon={Server}>
          {statusQuery.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-20 animate-pulse rounded-2xl bg-white dark:bg-[#111]" />
              ))}
            </div>
          ) : statusQuery.data ? (
            <div className="space-y-4">
              <div
                className={cn(
                  "rounded-2xl border p-4",
                  statusQuery.data.status === "operational"
                    ? "border-emerald-500/30 bg-emerald-500/10"
                    : statusQuery.data.status === "degraded"
                      ? "border-amber-500/30 bg-amber-500/10"
                      : "border-red-500/30 bg-red-500/10"
                )}
              >
                <p className="text-lg font-semibold capitalize text-gray-900 dark:text-[#f2f2f2]">{statusQuery.data.status}</p>
                <p className="mt-1 text-sm text-gray-600 dark:text-[#b8b8b8]">
                  Checked {timeAgo(statusQuery.data.checkedAt)} · {statusQuery.data.metrics.readyNodes}/{statusQuery.data.metrics.totalNodes} nodes ready
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <DashboardStatCard label="Nodes" value={statusQuery.data.metrics.totalNodes} tone="neutral" className="p-3" />
                <DashboardStatCard label="Ready" value={statusQuery.data.metrics.readyNodes} tone="success" className="p-3" />
                <DashboardStatCard label="Reported uptime" value={statusQuery.data.metrics.uptime} tone="info" className="p-3" />
              </div>
              <div className="space-y-2">
                {statusQuery.data.services.map((service) => (
                  <div key={service.name} className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-3 text-sm">
                    <span className="text-gray-900 dark:text-[#f2f2f2]">{service.name}</span>
                    <div className="flex items-center gap-2">
                      {service.latencyMs > 0 ? <span className="text-xs text-gray-400 dark:text-[#666]">{service.latencyMs} ms</span> : null}
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-medium capitalize",
                          service.status === "operational"
                            ? "bg-emerald-500/10 text-emerald-200"
                            : service.status === "degraded"
                              ? "bg-amber-500/10 text-amber-200"
                              : "bg-red-500/10 text-red-200"
                        )}
                      >
                        {service.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </DashboardPanel>

        <DashboardPanel title="Operational notes" description="Investigation helpers and operator cues collected from the current state of the dashboard." icon={Download}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Keyboard flow</p>
              <ul className="mt-3 space-y-2 text-sm text-gray-600 dark:text-[#b8b8b8]">
                <li>
                  <span className="font-medium text-gray-900 dark:text-white">/</span> focuses service search.
                </li>
                <li>
                  <span className="font-medium text-gray-900 dark:text-white">Esc</span> clears search and issue filters.
                </li>
                <li>Use the export menu to hand off filtered watchlists.</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">What changed</p>
              <ul className="mt-3 space-y-2 text-sm text-gray-600 dark:text-[#b8b8b8]">
                <li>Alert summary now sits above the fold.</li>
                <li>Time-range selection keeps charts understandable.</li>
                <li>Latency, SLA, and warnings can be cross-referenced in one screen.</li>
              </ul>
            </div>
          </div>
        </DashboardPanel>
      </div>
    </div>
  );
}
