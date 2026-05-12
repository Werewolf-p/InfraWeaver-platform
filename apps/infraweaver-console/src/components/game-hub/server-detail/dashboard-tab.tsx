"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Download, HardDrive, Server, Users, Wifi } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import type { BackupEntry, DiskUsage, GameEvent, MetricPoint, PlayerStats, PluginsData, ServerDetail } from "./types";
import { fetchJson } from "./utils";

function Uptime({ startTime }: { startTime: string | null }) {
  const secs = startTime ? Math.max(0, Math.floor((Date.now() - new Date(startTime).getTime()) / 1000)) : 0;
  if (!startTime) return <>—</>;
  if (secs < 60) return <>{secs}s</>;
  if (secs < 3600) return <>{Math.floor(secs / 60)}m {secs % 60}s</>;
  return <>{Math.floor(secs / 3600)}h {Math.floor((secs % 3600) / 60)}m</>;
}

export function DashboardTab({ name, server }: { name: string; server: ServerDetail }) {
  const { data: metrics } = useQuery({ queryKey: ["game-hub", "metrics", name], queryFn: () => fetchJson<MetricPoint[]>(`/api/game-hub/servers/${name}/metrics`), refetchInterval: 15000 });
  const { data: disk } = useQuery({ queryKey: ["game-hub", "disk", name], queryFn: () => fetchJson<DiskUsage>(`/api/game-hub/servers/${name}/disk`), enabled: server.replicas > 0, refetchInterval: 30000 });
  const { data: backups, refetch: refetchBackups } = useQuery({ queryKey: ["game-hub", "backups", name], queryFn: () => fetchJson<{ backups: BackupEntry[] }>(`/api/game-hub/servers/${name}/backups`), enabled: server.replicas > 0 });
  const { data: events } = useQuery({ queryKey: ["game-hub", "events-preview", name], queryFn: () => fetchJson<{ events: GameEvent[] }>(`/api/game-hub/servers/${name}/events`), refetchInterval: 30000 });
  const { data: players } = useQuery({ queryKey: ["game-hub", "players-preview", name], queryFn: () => fetchJson<{ count: number; history: Array<{ t: number; n: number }> }>(`/api/game-hub/servers/${name}/players`), enabled: server.replicas > 0, refetchInterval: 30000 });
  const { data: stats } = useQuery({ queryKey: ["game-hub", "stats-preview", name], queryFn: () => fetchJson<PlayerStats>(`/api/game-hub/servers/${name}/stats`), enabled: server.replicas > 0, refetchInterval: 60000 });
  const { data: plugins } = useQuery({ queryKey: ["game-hub", "plugins-preview", name], queryFn: () => fetchJson<PluginsData>(`/api/game-hub/servers/${name}/plugins`), enabled: server.replicas > 0 });

  const points = metrics ?? [];
  const latest = points[points.length - 1];
  const cpuPct = latest?.cpuLimit ? Math.round((latest.cpu / latest.cpuLimit) * 100) : 0;
  const memoryPct = latest?.memoryLimit ? Math.round((latest.memory / latest.memoryLimit) * 100) : 0;
  const performance = Math.max(0, Math.min(100, (cpuPct < 50 ? 30 : 10) + (memoryPct < 80 ? 30 : 10) + (server.readyReplicas > 0 ? 20 : 0) + ((server.restartCount ?? 0) < 3 ? 20 : 0)));
  const playerHistory = (players?.history ?? server.playerHistory ?? []).map((point) => ({ t: new Date(point.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), n: point.n }));
  const chartData = points.map((point) => ({
    t: new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    cpu: point.cpuLimit ? Number(((point.cpu / point.cpuLimit) * 100).toFixed(1)) : 0,
    memory: point.memoryLimit ? Number(((point.memory / point.memoryLimit) * 100).toFixed(1)) : 0,
  }));

  async function createBackup() {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create" }) });
      toast.success("Backup created");
      refetchBackups();
    } catch (error) { toast.error(String(error)); }
  }

  async function deleteBackup(filename: string) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/backups`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename }) });
      toast.success("Backup deleted");
      refetchBackups();
    } catch (error) { toast.error(String(error)); }
  }

  return (
    <div className="space-y-4">
      {server.maintenanceMode && <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">Maintenance Mode Active</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Status</p><p className="text-sm text-[#f2f2f2] mt-1 capitalize">{server.maintenanceMode ? "maintenance" : (server.readyReplicas > 0 ? "running" : server.replicas > 0 ? "starting" : "stopped")}</p></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Uptime</p><p className="text-sm text-[#f2f2f2] mt-1"><Uptime startTime={server.podStartTime} /></p></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Connectivity</p><p className={`text-sm mt-1 ${server.portReachable ? "text-green-300" : "text-red-300"}`}>{server.portReachable ? "Port Open" : "Port Closed"}</p></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><p className="text-[10px] uppercase text-[#666]">Performance</p><p className={`text-sm mt-1 ${performance >= 80 ? "text-green-300" : performance >= 50 ? "text-yellow-300" : "text-red-300"}`}>{performance}/100</p></div>
      </div>

      <div className="grid lg:grid-cols-[2fr_1fr] gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-wide text-[#888]"><Server className="w-4 h-4 text-[#38bdf8]" /> CPU / RAM Graphs</div>
          <div className="h-56">{chartData.length === 0 ? <div className="h-full flex items-center justify-center text-sm text-[#666]">Waiting for metrics…</div> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><CartesianGrid stroke="#222" vertical={false} /><XAxis dataKey="t" tick={{ fill: "#666", fontSize: 10 }} /><YAxis tick={{ fill: "#666", fontSize: 10 }} unit="%" width={32} /><Tooltip contentStyle={{ background: "#111", border: "1px solid #333" }} /><Area dataKey="cpu" stroke="#38bdf8" fill="#38bdf833" /><Area dataKey="memory" stroke="#c084fc" fill="#c084fc22" /></AreaChart></ResponsiveContainer>}</div>
          <div className="grid grid-cols-2 gap-3 mt-3 text-xs text-[#777]"><div>CPU: <span className="text-[#d4d4d4]">{cpuPct}%</span></div><div>Memory: <span className="text-[#d4d4d4]">{memoryPct}%</span></div></div>
        </div>
        <div className="space-y-4">
          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><HardDrive className="w-4 h-4 text-[#34d399]" /> Storage Analytics</div>
            <div className="text-xs text-[#777] space-y-1"><div className="flex justify-between"><span>PVC</span><span className="text-[#d4d4d4]">{server.pvc?.name ?? "—"}</span></div><div className="flex justify-between"><span>Capacity</span><span className="text-[#d4d4d4]">{server.pvc?.size ?? "—"}</span></div><div className="flex justify-between"><span>Used</span><span className="text-[#d4d4d4]">{disk?.used ?? "—"}</span></div><div className="flex justify-between"><span>Available</span><span className="text-[#d4d4d4]">{disk?.available ?? "—"}</span></div></div>
            <div className="h-2 rounded-full bg-[#1a1a1a] overflow-hidden"><div className="h-full bg-[#34d399]" style={{ width: `${disk?.percent ?? 0}%` }} /></div>
          </div>
          <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
            <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide text-[#888]"><Users className="w-4 h-4 text-[#c084fc]" /> Player Timeline</div>
            <div className="h-24">{playerHistory.length === 0 ? <div className="h-full flex items-center justify-center text-sm text-[#666]">No player history yet</div> : <ResponsiveContainer width="100%" height="100%"><LineChart data={playerHistory}><Line dataKey="n" stroke="#c084fc" dot={false} strokeWidth={2} /><XAxis hide dataKey="t" /><YAxis hide /></LineChart></ResponsiveContainer>}</div>
            <p className="text-xs text-[#777] mt-2">Current players: <span className="text-[#f2f2f2]">{players?.count ?? 0}</span></p>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Download className="w-4 h-4 text-[#60a5fa]" /> Backups</div><button onClick={createBackup} className="px-3 py-1.5 rounded-lg bg-[#0078D4] text-white text-xs">Create Backup</button></div>
          <div className="space-y-2 max-h-52 overflow-y-auto">{(backups?.backups ?? []).length === 0 ? <p className="text-xs text-[#666]">No backups found</p> : backups?.backups.map((backup) => <div key={backup.filename} className="rounded-lg border border-[#222] px-3 py-2 flex items-center gap-2 text-xs"><div className="flex-1 min-w-0"><p className="text-[#f2f2f2] truncate">{backup.filename}</p><p className="text-[#666]">{backup.bytes} bytes</p></div><a href={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(`/tmp/${backup.filename}`)}&download=1`} className="text-[#60a5fa]">Download</a><button onClick={() => deleteBackup(backup.filename)} className="text-red-400">Delete</button></div>)}</div>
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Wifi className="w-4 h-4 text-[#22d3ee]" /> Network / Plugins</div>
          <p className="text-xs text-[#777]">Ports: <span className="text-[#d4d4d4]">{server.allPorts.map((port) => `${port.protocol} ${port.nodePort ?? port.port}`).join(", ") || "—"}</span></p>
          <div className="grid md:grid-cols-2 gap-3 text-xs"><div><p className="text-[#666] mb-2">Plugins</p>{(plugins?.plugins ?? []).length === 0 ? <p className="text-[#555]">None</p> : plugins?.plugins.map((plugin) => <div key={plugin} className="text-[#d4d4d4] truncate">{plugin}</div>)}</div><div><p className="text-[#666] mb-2">Mods</p>{(plugins?.mods ?? []).length === 0 ? <p className="text-[#555]">None</p> : plugins?.mods.map((mod) => <div key={mod} className="text-[#d4d4d4] truncate">{mod}</div>)}</div></div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Activity className="w-4 h-4 text-[#22c55e]" /> Recent Events</div>{(events?.events ?? []).slice(0, 6).map((event, index) => <div key={`${event.reason}-${index}`} className="rounded-lg border border-[#222] px-3 py-2"><p className="text-sm text-[#f2f2f2]">{event.reason}</p><p className="text-xs text-[#666] mt-1">{event.message}</p></div>)}</div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Users className="w-4 h-4 text-[#f59e0b]" /> Player Activity</div><p className="text-xs text-[#777]">Unique today: <span className="text-[#f2f2f2]">{stats?.uniqueToday ?? 0}</span></p><div className="grid md:grid-cols-2 gap-3 text-xs"><div><p className="text-[#666] mb-2">Recent joins</p>{(stats?.recentJoins ?? []).slice(0, 8).map((entry, index) => <div key={`${entry.player}-${index}`} className="text-[#d4d4d4]">{entry.player}</div>)}</div><div><p className="text-[#666] mb-2">Recent leaves</p>{(stats?.recentLeaves ?? []).slice(0, 8).map((entry, index) => <div key={`${entry.player}-${index}`} className="text-[#d4d4d4]">{entry.player}</div>)}</div></div></div>
      </div>
    </div>
  );
}
