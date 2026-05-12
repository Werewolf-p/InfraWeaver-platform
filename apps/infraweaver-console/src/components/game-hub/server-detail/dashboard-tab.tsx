"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Copy, Download, HardDrive, Layers, Network, Server, Terminal, Users, Wifi } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { BackupEntry, DiskUsage, GameEvent, MetricPoint, PlayerStats, PluginsData, ServerDetail } from "./types";
import { fetchJson } from "./utils";

function Uptime({ startTime }: { startTime: string | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const startedAt = new Date(startTime).getTime();
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  if (!startTime) return <>—</>;
  if (elapsed < 60) return <>{elapsed}s</>;
  if (elapsed < 3600) return <>{Math.floor(elapsed / 60)}m {elapsed % 60}s</>;
  if (elapsed < 86400) return <>{Math.floor(elapsed / 3600)}h {Math.floor((elapsed % 3600) / 60)}m</>;
  return <>{Math.floor(elapsed / 86400)}d {Math.floor((elapsed % 86400) / 3600)}h</>;
}

function computeHealth(server: ServerDetail, cpuPct: number, memoryPct: number) {
  const readyScore = server.readyReplicas > 0 ? 40 : 0;
  const restartPenalty = Math.min((server.restartCount ?? 0) * 5, 20);
  const cpuScore = cpuPct <= 0 ? 10 : cpuPct <= 80 ? 20 : cpuPct <= 95 ? 10 : 0;
  const memoryScore = memoryPct <= 0 ? 10 : memoryPct <= 80 ? 20 : memoryPct <= 95 ? 10 : 0;
  const ageHours = server.podStartTime ? (Date.now() - new Date(server.podStartTime).getTime()) / 3_600_000 : 0;
  const ageScore = !server.podStartTime ? 0 : ageHours >= 24 ? 20 : ageHours >= 1 ? 12 : 6;
  return Math.max(0, Math.min(100, readyScore + cpuScore + memoryScore + ageScore - restartPenalty));
}

function parsePsAux(raw: string) {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        user: parts[0] ?? "",
        pid: parts[1] ?? "",
        cpu: parts[2] ?? "",
        mem: parts[3] ?? "",
        command: parts.slice(10).join(" ") || parts.slice(4).join(" "),
      };
    });
}

export function DashboardTab({ name, server }: { name: string; server: ServerDetail }) {
  const [processOutput, setProcessOutput] = useState<string | null>(null);
  const [networkOutput, setNetworkOutput] = useState<string | null>(null);
  const [loadingProcesses, setLoadingProcesses] = useState(false);
  const [loadingNetwork, setLoadingNetwork] = useState(false);

  const { data: metrics } = useQuery({
    queryKey: ["game-hub", "metrics", name],
    queryFn: () => fetchJson<MetricPoint[]>(`/api/game-hub/servers/${name}/metrics`),
    refetchInterval: 15000,
  });
  const { data: disk } = useQuery({
    queryKey: ["game-hub", "disk", name],
    queryFn: () => fetchJson<DiskUsage>(`/api/game-hub/servers/${name}/disk`),
    enabled: server.replicas > 0,
    refetchInterval: 30000,
  });
  const { data: backups, refetch: refetchBackups } = useQuery({
    queryKey: ["game-hub", "backups", name],
    queryFn: () => fetchJson<{ backups: BackupEntry[] }>(`/api/game-hub/servers/${name}/backups`),
    enabled: server.replicas > 0,
  });
  const { data: events } = useQuery({
    queryKey: ["game-hub", "events-preview", name],
    queryFn: () => fetchJson<{ events: GameEvent[] }>(`/api/game-hub/servers/${name}/events`),
    refetchInterval: 30000,
  });
  const { data: players } = useQuery({
    queryKey: ["game-hub", "players-preview", name],
    queryFn: () => fetchJson<{ count: number; history: Array<{ t: number; n: number }> }>(`/api/game-hub/servers/${name}/players`),
    enabled: server.replicas > 0,
    refetchInterval: 30000,
  });
  const { data: stats } = useQuery({
    queryKey: ["game-hub", "stats-preview", name],
    queryFn: () => fetchJson<PlayerStats>(`/api/game-hub/servers/${name}/stats`),
    enabled: server.replicas > 0,
    refetchInterval: 60000,
  });
  const { data: plugins } = useQuery({
    queryKey: ["game-hub", "plugins-preview", name],
    queryFn: () => fetchJson<PluginsData>(`/api/game-hub/servers/${name}/plugins`),
    enabled: server.replicas > 0,
  });

  const latest = metrics?.[metrics.length - 1];
  const cpuPct = latest?.cpuLimit ? Math.round((latest.cpu / latest.cpuLimit) * 100) : 0;
  const memoryPct = latest?.memoryLimit ? Math.round((latest.memory / latest.memoryLimit) * 100) : 0;
  const healthScore = computeHealth(server, cpuPct, memoryPct);
  const healthTone = healthScore >= 80
    ? { text: "text-green-300", border: "border-green-500/30", bg: "bg-green-500/15", bar: "bg-green-500" }
    : healthScore >= 50
      ? { text: "text-yellow-300", border: "border-yellow-500/30", bg: "bg-yellow-500/15", bar: "bg-yellow-500" }
      : { text: "text-red-300", border: "border-red-500/30", bg: "bg-red-500/15", bar: "bg-red-500" };

  const playerHistory = (players?.history ?? server.playerHistory ?? []).map((point) => ({
    t: new Date(point.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    n: point.n,
  }));
  const chartData = (metrics ?? []).map((point) => ({
    t: new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    cpu: point.cpuLimit ? Number(((point.cpu / point.cpuLimit) * 100).toFixed(1)) : 0,
    memory: point.memoryLimit ? Number(((point.memory / point.memoryLimit) * 100).toFixed(1)) : 0,
  }));
  const oomEvent = (events?.events ?? []).find((event) =>
    event.reason === "OOMKilled"
    || event.reason === "OOMKilling"
    || event.message.toLowerCase().includes("oomkilled")
    || event.message.toLowerCase().includes("oom")
  );
  const host = server.nodeIp ?? "—";
  const primaryPort = server.allPorts.find((port) => port.nodePort) ?? server.allPorts[0] ?? null;
  const primaryAddress = primaryPort ? `${host}:${primaryPort.nodePort ?? primaryPort.port}` : host;
  const connectHint = server.egg?.connectionHint ?? server.egg?.description ?? "Connect using the address and port shown above";
  const processRows = useMemo(() => (processOutput ? parsePsAux(processOutput) : []), [processOutput]);

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

  async function runExec(command: string, setter: (value: string) => void, setLoading: (value: boolean) => void) {
    setLoading(true);
    try {
      const result = await fetchJson<{ stdout?: string; stderr?: string }>(`/api/game-hub/servers/${name}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      setter([result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
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
            <p className="text-sm font-medium text-orange-200">Pod was OOM killed</p>
            <p className="text-xs text-orange-300/80 mt-1">{oomEvent.message || "Consider increasing memory limit."}</p>
          </div>
        </div>
      )}

      {memoryPct > 80 && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-2.5 text-xs text-yellow-200">
          ⚠ Memory near limit — risk of eviction
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Status</p><p className="text-sm text-[#f2f2f2] mt-1 capitalize">{server.status ?? "unknown"}</p></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Uptime</p><p className="text-sm text-[#f2f2f2] mt-1"><Uptime startTime={server.podStartTime} /></p></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Connectivity</p><p className={cn("text-sm mt-1", server.portReachable ? "text-green-300" : "text-red-300")}>{server.portReachable ? "Port Open" : "Port Closed"}</p></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Restarts</p><p className={cn("text-sm mt-1", (server.restartCount ?? 0) > 3 ? "text-yellow-300" : "text-[#f2f2f2]")}>{server.restartCount ?? 0}</p></div>
        <div className={cn("rounded-xl border p-4", healthTone.border, healthTone.bg)}>
          <p className="text-[10px] uppercase text-[#666]">Health</p>
          <p className={cn("text-sm mt-1 font-semibold", healthTone.text)}>{healthScore}/100</p>
          <div className="h-1.5 rounded-full bg-[#1a1a1a] mt-2 overflow-hidden"><div className={cn("h-full rounded-full", healthTone.bar)} style={{ width: `${healthScore}%` }} /></div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[2fr_1fr] gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-wide text-[#888]"><Server className="w-4 h-4 text-[#38bdf8]" /> CPU / RAM Graphs</div>
          <div className="h-56">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-[#666]">Waiting for metrics…</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <CartesianGrid stroke="#222" vertical={false} />
                  <XAxis dataKey="t" tick={{ fill: "#666", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#666", fontSize: 10 }} unit="%" width={32} />
                  <Tooltip contentStyle={{ background: "#111", border: "1px solid #333" }} />
                  <Area dataKey="cpu" stroke="#38bdf8" fill="#38bdf833" />
                  <Area dataKey="memory" stroke="#c084fc" fill="#c084fc22" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3 text-xs text-[#777]">
            <div>CPU: <span className={cn(cpuPct > 90 ? "text-red-300" : cpuPct > 70 ? "text-yellow-300" : "text-[#d4d4d4]")}>{cpuPct}%</span></div>
            <div>Memory: <span className={cn(memoryPct > 90 ? "text-red-300" : memoryPct > 70 ? "text-yellow-300" : "text-[#d4d4d4]")}>{memoryPct}%</span></div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><HardDrive className="w-4 h-4 text-[#34d399]" /> Storage</div>
            <div className="text-xs text-[#777] space-y-1">
              <div className="flex justify-between"><span>PVC</span><span className="text-[#d4d4d4]">{server.pvc?.name ?? "—"}</span></div>
              <div className="flex justify-between"><span>Capacity</span><span className="text-[#d4d4d4]">{server.pvc?.size ?? "—"}</span></div>
              <div className="flex justify-between"><span>Used</span><span className="text-[#d4d4d4]">{disk?.filesystem.used ?? "—"}</span></div>
              <div className="flex justify-between"><span>Available</span><span className="text-[#d4d4d4]">{disk?.filesystem.available ?? "—"}</span></div>
            </div>
            <div className="h-2 rounded-full bg-[#1a1a1a] overflow-hidden"><div className={cn("h-full", (disk?.filesystem.percent ?? 0) > 85 ? "bg-red-500" : (disk?.filesystem.percent ?? 0) > 70 ? "bg-yellow-500" : "bg-[#34d399]")} style={{ width: `${disk?.filesystem.percent ?? 0}%` }} /></div>
            {disk?.topDirs?.length ? (
              <div className="space-y-1 pt-1">
                {disk.topDirs.slice(0, 6).map((entry) => (
                  <div key={`${entry.path}-${entry.size}`} className="flex justify-between text-[10px] text-[#666]"><span className="truncate max-w-[120px] font-mono">{entry.path}</span><span className="text-[#888]">{entry.size}</span></div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
            <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide text-[#888]"><Users className="w-4 h-4 text-[#c084fc]" /> Player Timeline</div>
            <div className="h-24">
              {playerHistory.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-[#666]">No player history yet</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={playerHistory}><Line dataKey="n" stroke="#c084fc" dot={false} strokeWidth={2} /><XAxis hide dataKey="t" /><YAxis hide /></LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="text-xs text-[#777] mt-2">Current players: <span className="text-[#f2f2f2]">{players?.count ?? 0}</span></p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#1e3a5f] bg-[#0a1929] p-4 space-y-3">
        <div className="flex items-center gap-2"><Wifi className="w-4 h-4 text-[#0078D4]" /><p className="text-xs font-semibold text-[#4fc3f7] uppercase tracking-wide">Connection Info</p><span className="ml-auto text-xl">{server.icon ?? "🎮"}</span></div>
        <div className="flex items-center gap-2">
          <div className="flex-1 font-mono text-sm text-[#e0e0e0] bg-[#0d1b2a] border border-[#1e3a5f] rounded-lg px-3 py-2 truncate">{primaryAddress}</div>
          <button onClick={() => { navigator.clipboard.writeText(primaryAddress); toast.success("Copied!"); }} className="flex-shrink-0 p-2 rounded-lg border border-[#1e3a5f] hover:bg-[#0d2137] text-[#4fc3f7] transition-colors"><Copy className="w-3.5 h-3.5" /></button>
        </div>
        <div className="space-y-1">
          {server.allPorts.map((port, index) => {
            const address = `${host}:${port.nodePort ?? port.port}`;
            return (
              <div key={`${port.name ?? port.port}-${index}`} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-mono flex-shrink-0", port.protocol === "UDP" ? "bg-purple-900/40 text-purple-300 border border-purple-700/40" : "bg-blue-900/40 text-blue-300 border border-blue-700/40")}>{port.protocol}</span>
                  {port.name && <span className="text-[#555] capitalize">{port.name.replace(/-/g, " ")}</span>}
                  <span className="text-[#888] font-mono truncate">{address}</span>
                </div>
                <button onClick={() => { navigator.clipboard.writeText(address); toast.success("Copied!"); }} className="flex-shrink-0 text-[#555] hover:text-[#4fc3f7] transition-colors p-0.5"><Copy className="w-3 h-3" /></button>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-[#4a6fa5] leading-relaxed">{connectHint}</p>
      </div>

      {server.podName && server.allPorts.length > 0 && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Terminal className="w-4 h-4 text-[#60a5fa]" /> Port-forward Helper</div>
          <div className="space-y-1.5">
            {server.allPorts.map((port, index) => {
              const localPort = port.nodePort ?? port.port;
              const remotePort = port.targetPort ?? port.port;
              const snippet = `kubectl port-forward -n game-hub pod/${server.podName} ${localPort}:${remotePort}`;
              return (
                <div key={`${port.name ?? port.port}-${index}`} className="flex items-center gap-2">
                  <code className="flex-1 text-[11px] font-mono text-[#9e9e9e] bg-[#0a0a0a] border border-[#1e1e1e] rounded px-2 py-1 truncate">{snippet}</code>
                  <button onClick={() => { navigator.clipboard.writeText(snippet); toast.success("Copied"); }} className="flex-shrink-0 p-1.5 text-[#444] hover:text-[#888] rounded transition-colors"><Copy className="w-3 h-3" /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(server.volumeMounts?.length || server.volumes?.length) ? (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Layers className="w-4 h-4 text-[#f59e0b]" /> Volume Mounts</div>
          <table className="w-full text-xs text-[#888]">
            <thead><tr className="text-[#555] text-[10px] uppercase"><th className="text-left py-1 pr-3">Name</th><th className="text-left py-1 pr-3">Mount Path</th><th className="text-left py-1 pr-3">Read Only</th><th className="text-left py-1">Size</th></tr></thead>
            <tbody>
              {(server.volumeMounts ?? []).map((mount, index) => {
                const volume = (server.volumes ?? []).find((entry) => entry.name === mount.name);
                return (
                  <tr key={`${mount.name}-${index}`} className="border-t border-[#1a1a1a]">
                    <td className="py-1 pr-3 font-mono text-[#d4d4d4]">{mount.name}</td>
                    <td className="py-1 pr-3 font-mono text-[#9e9e9e]">{mount.mountPath}</td>
                    <td className="py-1 pr-3">{mount.readOnly ? <span className="text-yellow-400">Yes</span> : <span className="text-[#555]">No</span>}</td>
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
            <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Terminal className="w-4 h-4 text-[#22d3ee]" /> Live Processes</div><button onClick={() => runExec("ps aux", setProcessOutput, setLoadingProcesses)} disabled={loadingProcesses} className="text-xs px-3 py-1.5 rounded-lg bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] hover:text-[#ccc] border border-[#2a2a2a] transition-colors disabled:opacity-50">{loadingProcesses ? "Loading…" : processOutput ? "Refresh" : "Load"}</button></div>
            {processOutput ? (
              processRows.length ? (
                <div className="overflow-x-auto max-h-64 overflow-y-auto"><table className="w-full text-[11px] font-mono"><thead className="text-[#555] text-[10px] uppercase sticky top-0 bg-[#111]"><tr><th className="text-left pb-1 pr-3">User</th><th className="text-left pb-1 pr-3">PID</th><th className="text-left pb-1 pr-3">CPU%</th><th className="text-left pb-1 pr-3">MEM%</th><th className="text-left pb-1">Command</th></tr></thead><tbody>{processRows.slice(0, 30).map((row, index) => <tr key={`${row.pid}-${index}`} className="border-t border-[#1a1a1a] text-[#9e9e9e]"><td className="py-0.5 pr-3 text-[#666]">{row.user}</td><td className="py-0.5 pr-3">{row.pid}</td><td className="py-0.5 pr-3">{row.cpu}</td><td className="py-0.5 pr-3">{row.mem}</td><td className="py-0.5 text-[#d4d4d4] truncate max-w-[240px]">{row.command}</td></tr>)}</tbody></table></div>
              ) : <p className="text-xs text-[#555]">No output</p>
            ) : <p className="text-xs text-[#555]">Load the current process list from inside the container.</p>}
          </div>

          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Network className="w-4 h-4 text-[#22d3ee]" /> Network Connections</div><button onClick={() => runExec("ss -tunp 2>/dev/null || netstat -tunp 2>/dev/null || echo 'not available'", setNetworkOutput, setLoadingNetwork)} disabled={loadingNetwork} className="text-xs px-3 py-1.5 rounded-lg bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] hover:text-[#ccc] border border-[#2a2a2a] transition-colors disabled:opacity-50">{loadingNetwork ? "Loading…" : networkOutput ? "Refresh" : "Load"}</button></div>
            {networkOutput ? <pre className="max-h-64 overflow-auto rounded-lg border border-[#1e1e1e] bg-[#0a0a0a] p-3 text-[11px] font-mono text-[#bdbdbd] whitespace-pre-wrap">{networkOutput}</pre> : <p className="text-xs text-[#555]">Inspect active TCP/UDP connections for this server pod.</p>}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Download className="w-4 h-4 text-[#60a5fa]" /> Backups</div><button onClick={createBackup} className="px-3 py-1.5 rounded-lg bg-[#0078D4] text-white text-xs">Create Backup</button></div>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {(backups?.backups ?? []).length === 0 ? <p className="text-xs text-[#666]">No backups found</p> : backups?.backups.map((backup) => (
              <div key={backup.filename} className="rounded-lg border border-[#222] px-3 py-2 flex items-center gap-2 text-xs">
                <div className="flex-1 min-w-0"><p className="text-[#f2f2f2] truncate">{backup.filename}</p><p className="text-[#666]">{backup.size}</p></div>
                <a href={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(`/tmp/${backup.filename}`)}&download=1`} className="text-[#60a5fa] hover:underline">Download</a>
                <button onClick={() => deleteBackup(backup.filename)} className="text-red-400 hover:text-red-300">Delete</button>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Wifi className="w-4 h-4 text-[#22d3ee]" /> Network / Artifacts</div>
          <p className="text-xs text-[#777]">Ports: <span className="text-[#d4d4d4]">{server.allPorts.map((port) => `${port.protocol} ${port.nodePort ?? port.port}`).join(", ") || "—"}</span></p>
          <div className="grid md:grid-cols-2 gap-3 text-xs">
            <div><p className="text-[#666] mb-2">Plugins</p>{(plugins?.plugins ?? []).length === 0 ? <p className="text-[#555]">None</p> : plugins?.plugins.map((plugin) => <div key={plugin} className="text-[#d4d4d4] truncate">{plugin}</div>)}</div>
            <div><p className="text-[#666] mb-2">Mods</p>{(plugins?.mods ?? []).length === 0 ? <p className="text-[#555]">None</p> : plugins?.mods.map((mod) => <div key={mod} className="text-[#d4d4d4] truncate">{mod}</div>)}</div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Activity className="w-4 h-4 text-[#22c55e]" /> Recent Events</div>
          {(events?.events ?? []).length === 0 ? <p className="text-xs text-[#666]">No recent events</p> : (events?.events ?? []).slice(0, 6).map((event, index) => (
            <div key={`${event.reason}-${index}`} className={cn("rounded-lg border px-3 py-2", event.type === "Warning" ? "border-yellow-500/20 bg-yellow-500/5" : "border-[#222]")}>
              <p className="text-sm text-[#f2f2f2]">{event.reason}</p>
              <p className="text-xs text-[#666] mt-1">{event.message}</p>
              {event.timestamp && <p className="text-[10px] text-[#444] mt-0.5">{new Date(event.timestamp).toLocaleString()}</p>}
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Users className="w-4 h-4 text-[#f59e0b]" /> Player Activity</div>
          <p className="text-xs text-[#777]">Unique today: <span className="text-[#f2f2f2]">{stats?.uniqueToday ?? 0}</span></p>
          <div className="grid md:grid-cols-2 gap-3 text-xs">
            <div><p className="text-[#666] mb-2">Recent joins</p>{(stats?.recentJoins ?? []).slice(0, 8).map((entry, index) => <div key={`${entry.player}-${index}`} className="text-[#d4d4d4]">{entry.player}</div>)}</div>
            <div><p className="text-[#666] mb-2">Recent leaves</p>{(stats?.recentLeaves ?? []).slice(0, 8).map((entry, index) => <div key={`${entry.player}-${index}`} className="text-[#d4d4d4]">{entry.player}</div>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
