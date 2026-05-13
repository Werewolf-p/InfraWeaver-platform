"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Copy,
  Download,
  HardDrive,
  Layers,
  Network,
  Server,
  Terminal,
  Users,
  Wifi,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type {
  BackupEntry,
  DiskUsage,
  GameEvent,
  MetricPoint,
  NetworkEntry,
  PlayerStats,
  PluginsData,
  ProcessEntry,
  ServerDetail,
} from "./types";
import { fetchJson } from "./utils";

type MetricsQueryResponse =
  | MetricPoint[]
  | { error?: string; points?: MetricPoint[] };

type NetworkStatsResponse =
  | NetworkEntry[]
  | { stats?: NetworkEntry[]; entries?: NetworkEntry[]; interfaces?: NetworkEntry[] };

type TrendIndicator = {
  direction: "up" | "down" | "flat";
  icon: string;
  className: string;
};

type NetworkSnapshot = {
  timestamp: number;
  rxBytes: number;
  txBytes: number;
};

type NetworkThroughputPoint = {
  t: string;
  rx: number;
  tx: number;
};

function Uptime({ startTime }: { startTime: string | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const startedAt = new Date(startTime).getTime();
    const update = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  if (!startTime) return <>—</>;
  if (elapsed < 60) return <>{elapsed}s</>;
  if (elapsed < 3600)
    return (
      <>
        {Math.floor(elapsed / 60)}m {elapsed % 60}s
      </>
    );
  if (elapsed < 86400)
    return (
      <>
        {Math.floor(elapsed / 3600)}h {Math.floor((elapsed % 3600) / 60)}m
      </>
    );
  return (
    <>
      {Math.floor(elapsed / 86400)}d {Math.floor((elapsed % 86400) / 3600)}h
    </>
  );
}

function computeHealth(server: ServerDetail, hasOomKilled: boolean) {
  let score = 0;
  const desiredReplicas = Math.max(server.replicas ?? 0, 0);
  const runtimeStatus =
    server.status ??
    (server.readyReplicas > 0
      ? "running"
      : desiredReplicas > 0
        ? "starting"
        : "stopped");

  if (runtimeStatus === "running") score += 40;
  if (server.readyReplicas === desiredReplicas) score += 20;
  if ((server.restartCount ?? 0) < 3) score += 20;
  if (!hasOomKilled) score += 20;

  return score;
}

const CPU_ALERT_THRESHOLD = 85;
const MEMORY_ALERT_THRESHOLD = 80;
const RESTART_ALERT_THRESHOLD = 5;
const NETWORK_POLL_INTERVAL_MS = 10000;
const CHART_TOOLTIP_STYLE = {
  background: "#111",
  border: "1px solid #333",
  borderRadius: "8px",
  fontSize: "12px",
};

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value)}%`;
}

function formatCpuMilli(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value)}m CPU`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function normalizeNetworkStats(payload: NetworkStatsResponse) {
  if (Array.isArray(payload)) return payload;
  return payload.stats ?? payload.entries ?? payload.interfaces ?? [];
}

function computeTrendIndicator(values: number[]): TrendIndicator {
  if (values.length < 4) {
    return { direction: "flat", icon: "→", className: "text-[#888]" };
  }

  const latest = values[values.length - 1] ?? 0;
  const previous = values.slice(-4, -1);
  const previousAverage =
    previous.reduce((sum, value) => sum + value, 0) / previous.length;

  if (previousAverage <= 0) {
    return latest > 0
      ? { direction: "up", icon: "↑", className: "text-red-400" }
      : { direction: "flat", icon: "→", className: "text-[#888]" };
  }

  if (latest > previousAverage * 1.05) {
    return { direction: "up", icon: "↑", className: "text-red-400" };
  }

  if (latest < previousAverage * 0.95) {
    return { direction: "down", icon: "↓", className: "text-green-400" };
  }

  return { direction: "flat", icon: "→", className: "text-[#888]" };
}

function truncateText(value: string, maxLength = 80) {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 1))}…`
    : value;
}

export function DashboardTab({
  name,
  server,
}: {
  name: string;
  server: ServerDetail;
}) {
  const {
    data: metricsResponse,
    isLoading: metricsLoading,
    error: metricsQueryError,
  } = useQuery({
    queryKey: ["game-hub", "metrics", name],
    queryFn: async () => {
      const result = await fetchJson<MetricsQueryResponse>(
        `/api/game-hub/servers/${name}/metrics`,
      );
      return Array.isArray(result)
        ? { points: result, error: null as string | null }
        : { points: result.points ?? [], error: result.error ?? null };
    },
    enabled: server.replicas > 0,
    refetchInterval: server.replicas > 0 ? 15000 : false,
    retry: false,
  });
  const { data: disk } = useQuery({
    queryKey: ["game-hub", "disk", name],
    queryFn: () => fetchJson<DiskUsage>(`/api/game-hub/servers/${name}/disk`),
    enabled: server.replicas > 0,
    refetchInterval: 30000,
  });
  const { data: backups, refetch: refetchBackups } = useQuery({
    queryKey: ["game-hub", "backups", name],
    queryFn: () =>
      fetchJson<{ backups: BackupEntry[] }>(
        `/api/game-hub/servers/${name}/backups`,
      ),
    enabled: server.replicas > 0,
  });
  const { data: events } = useQuery({
    queryKey: ["game-hub", "events-preview", name],
    queryFn: () =>
      fetchJson<{ events: GameEvent[] }>(
        `/api/game-hub/servers/${name}/events`,
      ),
    refetchInterval: 30000,
  });
  const { data: players } = useQuery({
    queryKey: ["game-hub", "players-preview", name],
    queryFn: () =>
      fetchJson<{ count: number; history: Array<{ t: number; n: number }> }>(
        `/api/game-hub/servers/${name}/players`,
      ),
    enabled: server.replicas > 0,
    refetchInterval: 30000,
  });
  const { data: stats } = useQuery({
    queryKey: ["game-hub", "stats-preview", name],
    queryFn: () =>
      fetchJson<PlayerStats>(`/api/game-hub/servers/${name}/stats`),
    enabled: server.replicas > 0,
    refetchInterval: 60000,
  });
  const { data: plugins } = useQuery({
    queryKey: ["game-hub", "plugins-preview", name],
    queryFn: () =>
      fetchJson<PluginsData>(`/api/game-hub/servers/${name}/plugins`),
    enabled: server.replicas > 0,
  });
  const {
    data: processes,
    refetch: refetchProcesses,
    isFetching: loadingProcesses,
  } = useQuery({
    queryKey: ["game-hub", "processes", name],
    queryFn: () =>
      fetchJson<{ processes: ProcessEntry[] }>(
        `/api/game-hub/servers/${name}/processes`,
      ),
    enabled: false,
  });
  const {
    data: network,
    refetch: refetchNetwork,
    isFetching: loadingNetwork,
  } = useQuery({
    queryKey: ["game-hub", "network", name],
    queryFn: () =>
      fetchJson<{ stats: NetworkEntry[] }>(
        `/api/game-hub/servers/${name}/network`,
      ),
    enabled: false,
  });
  const networkHistoryRef = useRef<NetworkSnapshot[]>([]);
  const [networkThroughputData, setNetworkThroughputData] =
    useState<NetworkThroughputPoint[]>([]);
  const [networkThroughputError, setNetworkThroughputError] = useState<
    string | null
  >(null);
  const isServerRunning = server.status === "running" || server.replicas > 0;

  useEffect(() => {
    let cancelled = false;

    if (!isServerRunning) {
      networkHistoryRef.current = [];
      setNetworkThroughputData([]);
      setNetworkThroughputError(null);
      return () => {
        cancelled = true;
      };
    }

    const pollNetworkThroughput = async () => {
      try {
        const payload = await fetchJson<NetworkStatsResponse>(
          `/api/game-hub/servers/${name}/network-stats`,
        );
        if (cancelled) return;

        const stats = normalizeNetworkStats(payload);
        const nextSnapshot = {
          timestamp: Date.now(),
          rxBytes: stats.reduce((sum, row) => sum + (row.rxBytes ?? 0), 0),
          txBytes: stats.reduce((sum, row) => sum + (row.txBytes ?? 0), 0),
        };
        const snapshots = [...networkHistoryRef.current, nextSnapshot].slice(-30);
        networkHistoryRef.current = snapshots;

        const throughputPoints = snapshots.slice(1).map((snapshot, index) => {
          const previous = snapshots[index];
          const intervalSeconds = Math.max(
            (snapshot.timestamp - previous.timestamp) / 1000,
            1,
          );

          return {
            t: new Date(snapshot.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            rx: Math.max(
              0,
              (snapshot.rxBytes - previous.rxBytes) / intervalSeconds,
            ),
            tx: Math.max(
              0,
              (snapshot.txBytes - previous.txBytes) / intervalSeconds,
            ),
          };
        });

        setNetworkThroughputData(throughputPoints);
        setNetworkThroughputError(null);
      } catch (error) {
        if (!cancelled) {
          setNetworkThroughputError(
            error instanceof Error
              ? error.message
              : "Unable to load network throughput.",
          );
        }
      }
    };

    void pollNetworkThroughput();
    const interval = window.setInterval(() => {
      void pollNetworkThroughput();
    }, NETWORK_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isServerRunning, name]);

  const metrics = metricsResponse?.points ?? [];
  const metricsErrorMessage =
    metricsResponse?.error ??
    (metricsQueryError instanceof Error ? metricsQueryError.message : null);
  const metricsError = Boolean(metricsErrorMessage);
  const latest = metrics[metrics.length - 1];
  const cpuPct = latest?.cpuLimit
    ? Number(((latest.cpu / latest.cpuLimit) * 100).toFixed(1))
    : null;
  const memoryPct = latest?.memoryLimit
    ? Number(((latest.memory / latest.memoryLimit) * 100).toFixed(1))
    : null;
  const cpuUsesPercent = Boolean(latest?.cpuLimit);
  const memoryUsesPercent = Boolean(latest?.memoryLimit);
  const cpuMetricLabel = cpuUsesPercent
    ? formatPercent(cpuPct)
    : formatCpuMilli(latest?.cpuRaw ?? null);
  const memoryMetricLabel = memoryUsesPercent
    ? formatPercent(memoryPct)
    : formatBytes(latest?.memoryRaw ?? 0);
  const cpuObservedMax = Math.max(...metrics.map((point) => point.cpuRaw), 1);
  const memoryObservedMax = Math.max(
    ...metrics.map((point) => point.memoryRaw),
    1,
  );
  const cpuBarWidth = cpuUsesPercent
    ? Math.min(cpuPct ?? 0, 100)
    : Math.min(((latest?.cpuRaw ?? 0) / cpuObservedMax) * 100, 100);
  const memoryBarWidth = memoryUsesPercent
    ? Math.min(memoryPct ?? 0, 100)
    : Math.min(((latest?.memoryRaw ?? 0) / memoryObservedMax) * 100, 100);
  const eventFeed = server.events?.length
    ? server.events
    : (events?.events ?? []);
  const oomEvent = eventFeed.find(
    (event) =>
      event.reason === "OOMKilled" ||
      event.reason === "OOMKilling" ||
      event.message.toLowerCase().includes("oomkilled") ||
      event.message.toLowerCase().includes("oom"),
  );
  const healthScore = computeHealth(server, Boolean(oomEvent));
  const healthTone =
    healthScore >= 80
      ? {
          text: "text-green-300",
          border: "border-green-500/30",
          bg: "bg-green-500/10",
          fill: "bg-green-500",
          badge: "Healthy",
        }
      : healthScore >= 50
        ? {
            text: "text-yellow-300",
            border: "border-yellow-500/30",
            bg: "bg-yellow-500/10",
            fill: "bg-yellow-500",
            badge: "Degraded",
          }
        : {
            text: "text-red-300",
            border: "border-red-500/30",
            bg: "bg-red-500/10",
            fill: "bg-red-500",
            badge: "Unhealthy",
          };

  const playerHistory = (players?.history ?? server.playerHistory ?? [])
    .slice(-100)
    .map((point) => ({
      t: new Date(point.t).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      n: point.n,
    }));
  const metricWindow = metrics.slice(-20);
  const cpuChartData = metricWindow.map((point) => ({
    t: new Date(point.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    value: point.cpuLimit
      ? Number(((point.cpu / point.cpuLimit) * 100).toFixed(1))
      : point.cpuRaw,
  }));
  const memoryChartData = metricWindow.map((point) => ({
    t: new Date(point.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    value: point.memoryLimit
      ? Number(((point.memory / point.memoryLimit) * 100).toFixed(1))
      : Number((point.memoryRaw / 1024 ** 2).toFixed(1)),
  }));
  const cpuAverage = cpuChartData.length
    ? cpuChartData.reduce((sum, point) => sum + point.value, 0) /
      cpuChartData.length
    : 0;
  const memoryAverage = memoryChartData.length
    ? memoryChartData.reduce((sum, point) => sum + point.value, 0) /
      memoryChartData.length
    : 0;
  const cpuTrend = computeTrendIndicator(
    cpuChartData.map((point) => point.value),
  );
  const memoryTrend = computeTrendIndicator(
    memoryChartData.map((point) => point.value),
  );
  const latestNetworkThroughput =
    networkThroughputData[networkThroughputData.length - 1];
  const networkThroughputMessage = !isServerRunning
    ? "Network throughput unavailable while the server is stopped."
    : networkThroughputError
      ? `Network stats unavailable: ${networkThroughputError}`
      : networkThroughputData.length === 0
        ? "Polling network throughput…"
        : null;
  const crashEvents = [...eventFeed]
    .filter((event) => /OOMKill|CrashLoopBackOff|BackOff|Error|Failed/i.test(event.reason))
    .sort((left, right) => {
      const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0;
      const rightTime = right.timestamp ? new Date(right.timestamp).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, 5);
  const chartIdPrefix = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const cpuGradientId = `${chartIdPrefix}-cpu-gradient`;
  const memoryGradientId = `${chartIdPrefix}-memory-gradient`;
  const networkRxGradientId = `${chartIdPrefix}-network-rx-gradient`;
  const networkTxGradientId = `${chartIdPrefix}-network-tx-gradient`;
  const playerGradientId = `${chartIdPrefix}-player-gradient`;
  const host = server.nodeIp ?? "Unavailable";
  const connectionRows = (
    server.allPorts.length
      ? server.allPorts
      : [
          {
            name: "game",
            port: server.port ?? 0,
            targetPort: server.port,
            nodePort: server.nodePort,
            protocol: "TCP",
          },
        ]
  )
    .filter((port) => port.port > 0)
    .map((port, index) => ({
      id: `${port.name ?? port.port}-${index}`,
      label: port.name
        ? port.name.replace(/-/g, " ")
        : index === 0
          ? "game"
          : `port ${index + 1}`,
      protocol: port.protocol,
      servicePort: port.port,
      nodePort: port.nodePort,
      address:
        host === "Unavailable"
          ? `Port ${port.nodePort ?? port.port}`
          : `${host}:${port.nodePort ?? port.port}`,
    }));
  const primaryAddress = connectionRows[0]?.address ?? host;
  const connectHint =
    server.egg?.connectionHint ??
    "Use the address below with your game client.";
  const processRows = processes?.processes ?? [];
  const networkRows = network?.stats ?? [];
  const metricsMessage =
    server.replicas === 0
      ? "No data while the server is stopped."
      : metricsError &&
          metricsErrorMessage?.toLowerCase().includes("metrics-server")
        ? "Metrics server not available. Install metrics-server to enable CPU/RAM charts."
        : metricsError
          ? "No data available from the metrics API."
          : metricsLoading
            ? "Loading metrics…"
            : server.podName
              ? "Waiting for the first metrics sample from the cluster."
              : "Server pod is still starting up.";
  const restartCount = server.restartCount ?? 0;
  const alertThresholds = [
    {
      label: "CPU",
      threshold: `${CPU_ALERT_THRESHOLD}%`,
      triggered: (cpuPct ?? 0) >= CPU_ALERT_THRESHOLD,
      current: formatPercent(cpuPct),
    },
    {
      label: "Memory",
      threshold: `${MEMORY_ALERT_THRESHOLD}%`,
      triggered: (memoryPct ?? 0) >= MEMORY_ALERT_THRESHOLD,
      current: formatPercent(memoryPct),
    },
    {
      label: "Restarts",
      threshold: `${RESTART_ALERT_THRESHOLD}+`,
      triggered: restartCount >= RESTART_ALERT_THRESHOLD,
      current: String(restartCount),
    },
  ];

  async function createBackup() {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      toast.success("Backup created");
      refetchBackups();
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function restoreBackup(filename: string) {
    if (
      !window.confirm(
        "This will STOP the server, restore from backup, then restart. Continue?",
      )
    ) {
      return;
    }
    try {
      await fetchJson(`/api/game-hub/servers/${name}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", backupName: filename }),
      });
      toast.success("Backup restored");
      setTimeout(() => {
        void refetchBackups();
      }, 5000);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function deleteBackup(filename: string) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/backups`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      toast.success("Backup deleted");
      refetchBackups();
    } catch (error) {
      toast.error(String(error));
    }
  }

  function copyValue(value: string, label = "Copied") {
    navigator.clipboard.writeText(value);
    toast.success(label);
  }

  return (
    <div className="space-y-4">
      {server.maintenanceMode && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
          Maintenance mode active
        </div>
      )}

      {oomEvent && (
        <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 flex items-start gap-3">
          <span className="text-lg">⚠</span>
          <div>
            <p className="text-sm font-medium text-orange-200">
              Pod was OOM killed
            </p>
            <p className="text-xs text-orange-300/80 mt-1">
              {oomEvent.message || "Consider increasing memory limit."}
            </p>
          </div>
        </div>
      )}

      {cpuPct !== null && cpuPct >= CPU_ALERT_THRESHOLD && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-2.5 text-xs text-yellow-200">
          CPU usage crossed the alert threshold.
        </div>
      )}

      {memoryPct !== null && memoryPct >= MEMORY_ALERT_THRESHOLD && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-2.5 text-xs text-yellow-200">
          Memory near limit — risk of eviction
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        {alertThresholds.map((alert) => (
          <div
            key={alert.label}
            className={cn(
              "rounded-xl border px-4 py-3",
              alert.triggered
                ? "border-yellow-500/30 bg-yellow-500/10"
                : "border-[#2a2a2a] bg-[#111]",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] uppercase tracking-wide text-[#666]">
                {alert.label} alert threshold
              </p>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px]",
                  alert.triggered
                    ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-200"
                    : "border-[#2a2a2a] text-[#777]",
                )}
              >
                {alert.triggered ? "Triggered" : "Normal"}
              </span>
            </div>
            <div className="mt-2 flex items-end justify-between gap-3">
              <div>
                <p className="text-xl font-semibold text-[#f2f2f2]">
                  {alert.current}
                </p>
                <p className="text-[11px] text-[#666]">Current</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium text-[#d4d4d4]">
                  {alert.threshold}
                </p>
                <p className="text-[11px] text-[#666]">Threshold</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <p className="text-[10px] uppercase text-[#666]">Status</p>
          <p className="text-sm text-[#f2f2f2] mt-1 capitalize">
            {server.status ?? "unknown"}
          </p>
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <p className="text-[10px] uppercase text-[#666]">Uptime</p>
          <p className="text-sm text-[#f2f2f2] mt-1">
            <Uptime startTime={server.podStartTime} />
          </p>
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <p className="text-[10px] uppercase text-[#666]">Connectivity</p>
          <p
            className={cn(
              "text-sm mt-1",
              server.portReachable === true
                ? "text-green-300"
                : server.portReachable === false
                  ? "text-red-300"
                  : "text-[#999]",
            )}
          >
            {server.portReachable === true
              ? "Port Open"
              : server.portReachable === false
                ? "Port Closed"
                : "Unknown"}
          </p>
        </div>
        <div
          className={cn(
            "rounded-xl border p-4",
            restartCount > 5
              ? "border-red-500/30 bg-red-500/10"
              : "border-[#2a2a2a] bg-[#111]",
          )}
        >
          <p className="text-[10px] uppercase text-[#666]">Restarts</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <p
              className={cn(
                "text-2xl font-semibold",
                restartCount > 5
                  ? "text-red-300"
                  : restartCount > 2
                    ? "text-yellow-300"
                    : "text-[#f2f2f2]",
              )}
            >
              {restartCount}
            </p>
            {restartCount > 5 && (
              <span className="rounded-full border border-red-500/30 bg-red-500/15 px-2 py-0.5 text-[10px] text-red-200">
                Warning
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#666] mt-2">
            {restartCount > 5
              ? "Frequent restarts detected."
              : "Container restart count."}
          </p>
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <p className="text-[10px] uppercase text-[#666]">Ready Replicas</p>
          <p className="text-sm text-[#f2f2f2] mt-1">
            {server.readyReplicas}/{server.replicas}
          </p>
        </div>
        <div
          className={cn(
            "rounded-xl border p-4",
            healthTone.border,
            healthTone.bg,
          )}
        >
          <p className="text-[10px] uppercase text-[#666]">Server Health</p>
          <div className="mt-2 flex items-center gap-3">
            <div className="relative h-14 w-14 rounded-full border border-white/10 bg-[#0d0d0d] flex items-center justify-center">
              <div
                className={cn(
                  "absolute inset-1 rounded-full opacity-15",
                  healthTone.fill,
                )}
              />
              <span
                className={cn(
                  "relative text-sm font-semibold",
                  healthTone.text,
                )}
              >
                {healthScore}%
              </span>
            </div>
            <div>
              <p className={cn("text-sm font-semibold", healthTone.text)}>
                {healthTone.badge}
              </p>
              <p className="text-[11px] text-[#666] mt-1">
                Running, readiness, restarts, and OOM state.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
          <Activity className="w-4 h-4 text-[#f87171]" /> Crash History
        </div>
        {crashEvents.length === 0 ? (
          <p className="text-xs text-[#666]">No crash events</p>
        ) : (
          <div className="space-y-3">
            {crashEvents.map((event, index) => {
              const isSevere = /OOMKill|CrashLoopBackOff/i.test(event.reason);
              return (
                <div key={`${event.reason}-${event.timestamp ?? index}`} className="flex gap-3">
                  <div className="flex flex-col items-center pt-1">
                    <span
                      className={cn(
                        "h-2.5 w-2.5 rounded-full",
                        isSevere ? "bg-red-400" : "bg-orange-400",
                      )}
                    />
                    {index < crashEvents.length - 1 && (
                      <span className="mt-1 h-full w-px bg-[#2a2a2a]" />
                    )}
                  </div>
                  <div className="min-w-0 pb-1">
                    <p className="text-sm text-[#f2f2f2]">{event.reason}</p>
                    <p className="mt-1 text-xs text-[#888]">
                      {truncateText(event.message || "No event message")}
                    </p>
                    <p className="mt-1 text-[10px] text-[#555]">
                      {formatDateTime(event.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-[2fr_1fr] gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
            <Server className="w-4 h-4 text-[#38bdf8]" />
            Resource Metrics
          </div>
          <div className="mb-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase text-[#666]">CPU</p>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-2xl font-semibold text-[#f2f2f2]">
                      {cpuMetricLabel}
                    </p>
                    <span className={cn("text-sm font-medium", cpuTrend.className)}>
                      {cpuTrend.icon}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-[#666]">
                    {latest
                      ? cpuUsesPercent
                        ? `${latest.cpu.toFixed(2)} / ${latest.cpuLimit.toFixed(2)} cores`
                        : `${latest.cpuRaw.toFixed(0)}m total`
                      : "No data"}
                  </p>
                </div>
                <div className="h-10 w-24 shrink-0">
                  {cpuChartData.length > 1 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={cpuChartData}>
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="#38bdf8"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#1a1a1a]">
                <div
                  className={cn(
                    "h-full rounded-full",
                    (cpuPct ?? 0) >= 90
                      ? "bg-red-500"
                      : (cpuPct ?? 0) >= 70
                        ? "bg-yellow-500"
                        : "bg-sky-500",
                  )}
                  style={{ width: `${cpuBarWidth}%` }}
                />
              </div>
            </div>
            <div className="rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase text-[#666]">Memory</p>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-2xl font-semibold text-[#f2f2f2]">
                      {memoryMetricLabel}
                    </p>
                    <span className={cn("text-sm font-medium", memoryTrend.className)}>
                      {memoryTrend.icon}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-[#666]">
                    {latest
                      ? memoryUsesPercent
                        ? `${formatBytes(latest.memory)} / ${formatBytes(latest.memoryLimit)}`
                        : `${formatBytes(latest.memoryRaw)} total`
                      : "No data"}
                  </p>
                </div>
                <div className="h-10 w-24 shrink-0">
                  {memoryChartData.length > 1 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={memoryChartData}>
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="#c084fc"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#1a1a1a]">
                <div
                  className={cn(
                    "h-full rounded-full",
                    (memoryPct ?? 0) >= 90
                      ? "bg-red-500"
                      : (memoryPct ?? 0) >= 70
                        ? "bg-yellow-500"
                        : "bg-violet-500",
                  )}
                  style={{ width: `${memoryBarWidth}%` }}
                />
              </div>
            </div>
          </div>
          {cpuChartData.length > 0 && memoryChartData.length > 0 ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-wide text-[#888]">CPU</p>
                  <p className="text-sm font-medium text-[#f2f2f2]">{cpuMetricLabel}</p>
                </div>
                <div className="h-[120px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={cpuChartData}>
                      <defs>
                        <linearGradient id={cpuGradientId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.85} />
                          <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#222" vertical={false} />
                      <XAxis dataKey="t" tick={{ fill: "#666", fontSize: 10 }} />
                      <YAxis
                        tick={{ fill: "#666", fontSize: 10 }}
                        width={48}
                        tickFormatter={(value) =>
                          cpuUsesPercent ? `${value}%` : `${Math.round(Number(value))}m`
                        }
                      />
                      <Tooltip
                        isAnimationActive
                        contentStyle={CHART_TOOLTIP_STYLE}
                        formatter={(value) => {
                          const numericValue = Number(value ?? 0);
                          return cpuUsesPercent
                            ? [`${numericValue.toFixed(1)}%`, "CPU"]
                            : [`${numericValue.toFixed(0)}m`, "CPU"];
                        }}
                      />
                      <ReferenceLine
                        y={cpuAverage}
                        stroke="#38bdf8"
                        strokeDasharray="4 4"
                        label={{ value: "avg", position: "insideTopRight", fill: "#888", fontSize: 10 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#38bdf8"
                        strokeWidth={2}
                        fill={`url(#${cpuGradientId})`}
                        dot={false}
                        isAnimationActive
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-wide text-[#888]">Memory</p>
                  <p className="text-sm font-medium text-[#f2f2f2]">{memoryMetricLabel}</p>
                </div>
                <div className="h-[120px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={memoryChartData}>
                      <defs>
                        <linearGradient id={memoryGradientId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#c084fc" stopOpacity={0.85} />
                          <stop offset="100%" stopColor="#c084fc" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#222" vertical={false} />
                      <XAxis dataKey="t" tick={{ fill: "#666", fontSize: 10 }} />
                      <YAxis
                        tick={{ fill: "#666", fontSize: 10 }}
                        width={56}
                        tickFormatter={(value) =>
                          memoryUsesPercent
                            ? `${value}%`
                            : `${Number(value).toFixed(0)} MiB`
                        }
                      />
                      <Tooltip
                        isAnimationActive
                        contentStyle={CHART_TOOLTIP_STYLE}
                        formatter={(value) => {
                          const numericValue = Number(value ?? 0);
                          return memoryUsesPercent
                            ? [`${numericValue.toFixed(1)}%`, "Memory"]
                            : [`${numericValue.toFixed(1)} MiB`, "Memory"];
                        }}
                      />
                      <ReferenceLine
                        y={memoryAverage}
                        stroke="#c084fc"
                        strokeDasharray="4 4"
                        label={{ value: "avg", position: "insideTopRight", fill: "#888", fontSize: 10 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#c084fc"
                        strokeWidth={2}
                        fill={`url(#${memoryGradientId})`}
                        dot={false}
                        isAnimationActive
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-[252px] items-center justify-center rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3 text-sm text-[#666]">
              {metricsMessage}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
              <HardDrive className="w-4 h-4 text-[#34d399]" /> Storage
            </div>
            <div className="text-xs text-[#777] space-y-1">
              <div className="flex justify-between">
                <span>PVC</span>
                <span className="text-[#d4d4d4]">
                  {server.pvc?.name ?? "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Capacity</span>
                <span className="text-[#d4d4d4]">
                  {server.pvc?.size ?? "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Used</span>
                <span className="text-[#d4d4d4]">
                  {disk?.filesystem.used ?? "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Available</span>
                <span className="text-[#d4d4d4]">
                  {disk?.filesystem.available ?? "—"}
                </span>
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[#1a1a1a]">
              <div
                className={cn(
                  "h-full",
                  (disk?.filesystem.percent ?? 0) > 85
                    ? "bg-red-500"
                    : (disk?.filesystem.percent ?? 0) > 70
                      ? "bg-yellow-500"
                      : "bg-[#34d399]",
                )}
                style={{ width: `${disk?.filesystem.percent ?? 0}%` }}
              />
            </div>
            {disk?.topDirs?.length ? (
              <div className="space-y-1 pt-1">
                {disk.topDirs.slice(0, 6).map((entry) => (
                  <div
                    key={`${entry.path}-${entry.size}`}
                    className="flex justify-between text-[10px] text-[#666]"
                  >
                    <span className="max-w-[120px] truncate font-mono">
                      {entry.path}
                    </span>
                    <span className="text-[#888]">{entry.size}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
                <Network className="w-4 h-4 text-[#22d3ee]" /> Network Throughput
              </div>
              <div className="text-right text-[10px] text-[#666]">
                <div>
                  RX <span className="text-[#67e8f9]">{latestNetworkThroughput ? `${formatBytes(latestNetworkThroughput.rx)}/s` : "—"}</span>
                </div>
                <div>
                  TX <span className="text-[#fbbf24]">{latestNetworkThroughput ? `${formatBytes(latestNetworkThroughput.tx)}/s` : "—"}</span>
                </div>
              </div>
            </div>
            <div className="h-[140px] rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3">
              {networkThroughputData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={networkThroughputData}>
                    <defs>
                      <linearGradient id={networkRxGradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.75} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id={networkTxGradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.75} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#222" vertical={false} />
                    <XAxis dataKey="t" tick={{ fill: "#666", fontSize: 10 }} />
                    <YAxis
                      tick={{ fill: "#666", fontSize: 10 }}
                      width={58}
                      tickFormatter={(value) => formatBytes(Number(value))}
                    />
                    <Tooltip
                      isAnimationActive
                      contentStyle={CHART_TOOLTIP_STYLE}
                      formatter={(value, label) => [
                        `${formatBytes(Number(value ?? 0))}/s`,
                        label === "rx" ? "RX" : "TX",
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="rx"
                      stroke="#22d3ee"
                      strokeWidth={2}
                      fill={`url(#${networkRxGradientId})`}
                      dot={false}
                      isAnimationActive
                    />
                    <Area
                      type="monotone"
                      dataKey="tx"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      fill={`url(#${networkTxGradientId})`}
                      dot={false}
                      isAnimationActive
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[#666]">
                  {networkThroughputMessage}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#1e3a5f] bg-[#0a1929] p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-[#0078D4]" />
          <p className="text-xs font-semibold text-[#4fc3f7] uppercase tracking-wide">
            How to connect
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-[#1e3a5f] bg-[#0d1b2a] p-3">
            <p className="text-[10px] uppercase text-[#4a6fa5]">Host</p>
            <p className="mt-1 font-mono text-sm text-[#e0e0e0] break-all">
              {host}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e3a5f] bg-[#0d1b2a] p-3">
            <p className="text-[10px] uppercase text-[#4a6fa5]">
              Primary address
            </p>
            <div className="mt-1 flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate font-mono text-sm text-[#e0e0e0]">
                {primaryAddress}
              </p>
              <button
                onClick={() => copyValue(primaryAddress)}
                className="flex-shrink-0 rounded-md border border-[#1e3a5f] p-1.5 text-[#4fc3f7] hover:bg-[#0d2137]"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-[#1e3a5f] bg-[#0d1b2a] p-3">
            <p className="text-[10px] uppercase text-[#4a6fa5]">Game port</p>
            <p className="mt-1 font-mono text-sm text-[#e0e0e0]">
              {connectionRows[0]?.servicePort ?? server.port ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e3a5f] bg-[#0d1b2a] p-3">
            <p className="text-[10px] uppercase text-[#4a6fa5]">NodePort</p>
            <p className="mt-1 font-mono text-sm text-[#e0e0e0]">
              {connectionRows[0]?.nodePort ?? "—"}
            </p>
          </div>
        </div>
        {server.nodeIp && server.nodePort && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#1e3a5f] bg-[#0d1b2a] px-3 py-2 text-xs text-[#9ccfff]">
            <div>
              <span className="text-[#4a6fa5]">External:</span>{" "}
              <span className="font-mono text-[#e0e0e0]">
                {server.nodeIp}:{server.nodePort}
              </span>
            </div>
            <Link
              href={`/gameservers?new=1&target=${encodeURIComponent(name)}&port=${server.nodePort}`}
              className="text-[#60a5fa] hover:text-[#93c5fd]"
            >
              Create Port Route →
            </Link>
          </div>
        )}
        <div className="space-y-2">
          {connectionRows.length === 0 ? (
            <p className="text-xs text-[#4a6fa5]">
              No exposed ports configured.
            </p>
          ) : (
            connectionRows.map((port) => (
              <div
                key={port.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1e3a5f] bg-[#0d1b2a] px-3 py-2 text-xs text-[#9ccfff]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-mono",
                      port.protocol === "UDP"
                        ? "border-purple-500/30 bg-purple-500/10 text-purple-200"
                        : "border-blue-500/30 bg-blue-500/10 text-blue-200",
                    )}
                  >
                    {port.protocol}
                  </span>
                  <span className="capitalize">{port.label}</span>
                  <span className="font-mono text-[#e0e0e0] truncate">
                    {port.address}
                  </span>
                  <span className="text-[#4a6fa5]">svc {port.servicePort}</span>
                  {port.nodePort && (
                    <span className="text-[#4a6fa5]">node {port.nodePort}</span>
                  )}
                </div>
                <button
                  onClick={() => copyValue(port.address)}
                  className="flex-shrink-0 rounded-md border border-[#1e3a5f] p-1.5 text-[#4fc3f7] hover:bg-[#0d2137]"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
        <p className="text-[11px] text-[#4a6fa5] leading-relaxed">
          {connectHint}
        </p>
      </div>

      {server.podName && server.allPorts.length > 0 && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
            <Terminal className="w-4 h-4 text-[#60a5fa]" /> Port-forward Helper
          </div>
          <div className="space-y-1.5">
            {server.allPorts.map((port, index) => {
              const localPort = port.nodePort ?? port.port;
              const remotePort = port.targetPort ?? port.port;
              const snippet = `kubectl port-forward -n game-hub pod/${server.podName} ${localPort}:${remotePort}`;
              return (
                <div
                  key={`${port.name ?? port.port}-${index}`}
                  className="flex items-center gap-2"
                >
                  <code className="flex-1 text-[11px] font-mono text-[#9e9e9e] bg-[#0a0a0a] border border-[#1e1e1e] rounded px-2 py-1 truncate">
                    {snippet}
                  </code>
                  <button
                    onClick={() => copyValue(snippet)}
                    className="flex-shrink-0 p-1.5 text-[#444] hover:text-[#888] rounded transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {server.volumeMounts?.length || server.volumes?.length ? (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
            <Layers className="w-4 h-4 text-[#f59e0b]" /> Volume Mounts
          </div>
          <table className="w-full text-xs text-[#888]">
            <thead>
              <tr className="text-[#555] text-[10px] uppercase">
                <th className="text-left py-1 pr-3">Name</th>
                <th className="text-left py-1 pr-3">Mount Path</th>
                <th className="text-left py-1 pr-3">Read Only</th>
                <th className="text-left py-1">Size</th>
              </tr>
            </thead>
            <tbody>
              {(server.volumeMounts ?? []).map((mount, index) => {
                const volume = (server.volumes ?? []).find(
                  (entry) => entry.name === mount.name,
                );
                return (
                  <tr
                    key={`${mount.name}-${index}`}
                    className="border-t border-[#1a1a1a]"
                  >
                    <td className="py-1 pr-3 font-mono text-[#d4d4d4]">
                      {mount.name}
                    </td>
                    <td className="py-1 pr-3 font-mono text-[#9e9e9e]">
                      {mount.mountPath}
                    </td>
                    <td className="py-1 pr-3">
                      {mount.readOnly ? (
                        <span className="text-yellow-400">Yes</span>
                      ) : (
                        <span className="text-[#555]">No</span>
                      )}
                    </td>
                    <td className="py-1">{volume?.pvcSize ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {server.replicas > 0 && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
                <Terminal className="w-4 h-4 text-[#22d3ee]" /> Live Processes
              </div>
              <button
                onClick={() => {
                  void refetchProcesses();
                }}
                disabled={loadingProcesses}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] hover:text-[#ccc] border border-[#2a2a2a] transition-colors disabled:opacity-50"
              >
                {loadingProcesses
                  ? "Loading…"
                  : processRows.length
                    ? "Refresh"
                    : "Load"}
              </button>
            </div>
            {processRows.length ? (
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead className="text-[#555] text-[10px] uppercase sticky top-0 bg-[#111]">
                    <tr>
                      <th className="text-left pb-1 pr-3">User</th>
                      <th className="text-left pb-1 pr-3">PID</th>
                      <th className="text-left pb-1 pr-3">CPU%</th>
                      <th className="text-left pb-1 pr-3">MEM%</th>
                      <th className="text-left pb-1">Command</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processRows.map((row) => (
                      <tr
                        key={`${row.pid}-${row.command}`}
                        className="border-t border-[#1a1a1a] text-[#9e9e9e]"
                      >
                        <td className="py-0.5 pr-3 text-[#666]">{row.user}</td>
                        <td className="py-0.5 pr-3">{row.pid}</td>
                        <td className="py-0.5 pr-3">{row.cpu.toFixed(1)}</td>
                        <td className="py-0.5 pr-3">{row.mem.toFixed(1)}</td>
                        <td className="py-0.5 text-[#d4d4d4] truncate max-w-[240px]">
                          {row.command}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[#555]">
                Load the current process list from inside the container.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
                <Network className="w-4 h-4 text-[#22d3ee]" /> Network Stats
              </div>
              <button
                onClick={() => {
                  void refetchNetwork();
                }}
                disabled={loadingNetwork}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] hover:text-[#ccc] border border-[#2a2a2a] transition-colors disabled:opacity-50"
              >
                {loadingNetwork
                  ? "Loading…"
                  : networkRows.length
                    ? "Refresh"
                    : "Load"}
              </button>
            </div>
            {networkRows.length ? (
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead className="text-[#555] text-[10px] uppercase sticky top-0 bg-[#111]">
                    <tr>
                      <th className="text-left pb-1 pr-3">Iface</th>
                      <th className="text-left pb-1 pr-3">RX</th>
                      <th className="text-left pb-1 pr-3">RX pkt</th>
                      <th className="text-left pb-1 pr-3">TX</th>
                      <th className="text-left pb-1">TX pkt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkRows.map((row) => (
                      <tr
                        key={row.iface}
                        className="border-t border-[#1a1a1a] text-[#9e9e9e]"
                      >
                        <td className="py-0.5 pr-3 text-[#d4d4d4]">
                          {row.iface}
                        </td>
                        <td className="py-0.5 pr-3">
                          {formatBytes(row.rxBytes)}
                        </td>
                        <td className="py-0.5 pr-3">{row.rxPackets}</td>
                        <td className="py-0.5 pr-3">
                          {formatBytes(row.txBytes)}
                        </td>
                        <td className="py-0.5">{row.txPackets}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[#555]">
                Inspect bytes in and out from /proc/net/dev for this server pod.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
              <Download className="w-4 h-4 text-[#60a5fa]" /> Backup Browser
            </div>
            <button
              onClick={createBackup}
              className="px-3 py-1.5 rounded-lg bg-[#0078D4] text-white text-xs"
            >
              Create Backup
            </button>
          </div>
          {(backups?.backups ?? []).length === 0 ? (
            <p className="text-xs text-[#666]">No backups found</p>
          ) : (
            <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-lg border border-[#1a1a1a]">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-[#0d0d0d] text-[#666]">
                  <tr>
                    <th className="px-3 py-2 text-left">Backup</th>
                    <th className="px-3 py-2 text-left">Size</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">SHA256</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(backups?.backups ?? []).map((backup) => (
                    <tr
                      key={backup.filename}
                      className="border-t border-[#1a1a1a] text-[#9e9e9e]"
                    >
                      <td className="px-3 py-2 font-mono text-[#d4d4d4]">
                        {backup.filename}
                      </td>
                      <td className="px-3 py-2">{backup.size}</td>
                      <td className="px-3 py-2">
                        {formatDateTime(backup.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        {backup.status === "warning" ? (
                          <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-yellow-200">
                            Small / check
                          </span>
                        ) : (
                          <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-green-200">
                            Verified
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px]">
                        {backup.checksum?.slice(0, 10) ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-3">
                          <a
                            href={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(backup.path ?? `/tmp/${backup.filename}`)}&download=1`}
                            className="text-[#60a5fa] hover:underline"
                          >
                            Download
                          </a>
                          <button
                            onClick={() => restoreBackup(backup.filename)}
                            className="text-green-300 hover:text-green-200"
                          >
                            Restore
                          </button>
                          <button
                            onClick={() => deleteBackup(backup.filename)}
                            className="text-red-400 hover:text-red-300"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
            <Wifi className="w-4 h-4 text-[#22d3ee]" /> Network / Artifacts
          </div>
          <p className="text-xs text-[#777]">
            Ports:{" "}
            <span className="text-[#d4d4d4]">
              {server.allPorts
                .map((port) => `${port.protocol} ${port.nodePort ?? port.port}`)
                .join(", ") || "—"}
            </span>
          </p>
          <div className="grid md:grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-[#666] mb-2">Plugins</p>
              {(plugins?.plugins ?? []).length === 0 ? (
                <p className="text-[#555]">None</p>
              ) : (
                plugins?.plugins.map((plugin) => (
                  <div key={plugin} className="text-[#d4d4d4] truncate">
                    {plugin}
                  </div>
                ))
              )}
            </div>
            <div>
              <p className="text-[#666] mb-2">Mods</p>
              {(plugins?.mods ?? []).length === 0 ? (
                <p className="text-[#555]">None</p>
              ) : (
                plugins?.mods.map((mod) => (
                  <div key={mod} className="text-[#d4d4d4] truncate">
                    {mod}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
            <Activity className="w-4 h-4 text-[#22c55e]" /> Recent Events
          </div>
          {eventFeed.length === 0 ? (
            <p className="text-xs text-[#666]">No recent events</p>
          ) : (
            eventFeed.slice(0, 5).map((event, index) => (
              <div
                key={`${event.reason}-${index}`}
                className={cn(
                  "rounded-lg border px-3 py-2",
                  event.type === "Warning"
                    ? "border-yellow-500/30 bg-yellow-500/10"
                    : "border-[#222]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-[#f2f2f2]">{event.reason}</p>
                  {event.type === "Warning" && (
                    <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[10px] text-yellow-200">
                      Warning
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[#666]">{event.message}</p>
                {event.timestamp && (
                  <p className="mt-0.5 text-[10px] text-[#444]">
                    {formatDateTime(event.timestamp)}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
            <Users className="w-4 h-4 text-[#f59e0b]" /> Player Activity
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#777]">
            <p>
              Unique today:{" "}
              <span className="text-[#f2f2f2]">{stats?.uniqueToday ?? 0}</span>
            </p>
            <p>
              Current players:{" "}
              <span className="text-[#f2f2f2]">{players?.count ?? 0}</span>
            </p>
          </div>
          <div className="grid gap-3 text-xs md:grid-cols-2">
            <div>
              <p className="mb-2 text-[#666]">Recent joins</p>
              {(stats?.recentJoins ?? []).slice(0, 8).map((entry, index) => (
                <div
                  key={`${entry.player}-${index}`}
                  className="text-[#d4d4d4]"
                >
                  {entry.player}
                </div>
              ))}
            </div>
            <div>
              <p className="mb-2 text-[#666]">Recent leaves</p>
              {(stats?.recentLeaves ?? []).slice(0, 8).map((entry, index) => (
                <div
                  key={`${entry.player}-${index}`}
                  className="text-[#d4d4d4]"
                >
                  {entry.player}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-wide text-[#888]">
                Player count history
              </p>
              <p className="text-[11px] text-[#666]">Last {playerHistory.length} samples</p>
            </div>
            <div className="h-[180px]">
              {playerHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-[#666]">
                  No player history yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={playerHistory}>
                    <defs>
                      <linearGradient id={playerGradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#34d399" stopOpacity={0.8} />
                        <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#222" vertical={false} />
                    <XAxis dataKey="t" tick={{ fill: "#666", fontSize: 10 }} />
                    <YAxis
                      tick={{ fill: "#666", fontSize: 10 }}
                      allowDecimals={false}
                      domain={[0, "auto"]}
                    />
                    <Tooltip
                      isAnimationActive
                      contentStyle={CHART_TOOLTIP_STYLE}
                      formatter={(value) => [String(value ?? 0), "Players"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="n"
                      stroke="#34d399"
                      strokeWidth={2}
                      fill={`url(#${playerGradientId})`}
                      dot={false}
                      isAnimationActive
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
