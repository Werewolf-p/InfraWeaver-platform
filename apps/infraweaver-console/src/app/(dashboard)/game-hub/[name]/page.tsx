"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, Play, Square, RotateCcw, Loader2, Terminal,
  Settings, FolderOpen, Activity, File, Folder, Save, Trash2,
  RefreshCw, Copy, ArrowUp, Send, Circle, AlertTriangle,
  Cpu, MemoryStick, Network, Clock, Gamepad2, LayoutDashboard,
  Shield, Server, Wifi, Layers, Download, FileText
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import Link from "next/link";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const GAME_ICONS: Record<string, string> = {
  minecraft: "⛏", "minecraft-java": "⛏", "minecraft-bedrock": "⛏",
  terraria: "🌍", valheim: "🪓", cs2: "🔫", rust: "🔩", ark: "🦕",
  factorio: "⚙️", satisfactory: "🏭", "project-zomboid": "��",
  vrising: "🧛", palworld: "🦎", "dont-starve-together": "🕯️",
  "seven-days-to-die": "💀", "team-fortress-2": "🎩", "garrys-mod": "🔧",
};

interface ServicePort {
  name: string | null;
  port: number;
  nodePort: number | null;
  protocol: string;
}

interface ServerDetail {
  name: string; gameType: string; replicas: number; readyReplicas: number;
  podName: string | null; podPhase: string | null; podStartTime: string | null;
  port: number | null; nodePort: number | null; nodeIp: string | null;
  allPorts: ServicePort[];
  hpa: { enabled: boolean; min: number; max: number; cpuTarget: number | null; currentReplicas: number | null };
  restartPolicy: string;
  memory: string; cpu: string; notes: string;
  env: Array<{ name: string; value?: string; valueFrom?: unknown }>; createdAt: string | null;
}

interface FileEntry {
  name: string; path: string; type: "file" | "directory" | "symlink" | "other";
  size: number; modifiedAt: string; permissions: string;
}

interface GameEvent {
  type: string;
  reason: string;
  message: string;
  timestamp: string | null;
  count: number;
  involvedKind: string;
  involvedName: string;
}

type TabId = "dashboard" | "console" | "files" | "settings" | "activity";

// ─── Uptime counter ───────────────────────────────────────────────────────────
function Uptime({ startTime }: { startTime: string | null }) {
  const [display, setDisplay] = useState("—");
  useEffect(() => {
    if (!startTime) { setDisplay("—"); return; }
    const update = () => {
      const secs = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);
      if (secs < 60) setDisplay(`${secs}s`);
      else if (secs < 3600) setDisplay(`${Math.floor(secs / 60)}m ${secs % 60}s`);
      else setDisplay(`${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [startTime]);
  return <>{display}</>;
}

// ─── Resource bar (visual gauge) ─────────────────────────────────────────────
function ResourceBar({ label, value, unit, color = "bg-[#0078D4]" }: {
  label: string; value: string; unit?: string; color?: string;
}) {
  // Parse memory values like "2.5Gi", "2048M", or CPU like "2", "500m"
  const pct = (() => {
    if (!value) return 0;
    const v = value.toLowerCase();
    if (v.includes("gi")) return Math.min((parseFloat(v) / 8) * 100, 100);
    if (v.includes("mi") || v.includes("m") && !v.includes("c")) {
      const mb = parseFloat(v);
      return Math.min((mb / 8192) * 100, 100);
    }
    if (v.includes("c") || (!isNaN(parseFloat(v)) && !v.includes("m"))) {
      return Math.min((parseFloat(v) / 8) * 100, 100);
    }
    return 30;
  })();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[#666]">{label}</span>
        <span className="text-[#9e9e9e] font-mono">{value || "—"}{unit}</span>
      </div>
      <div className="h-1.5 bg-[#1e1e1e] rounded-full overflow-hidden">
        <motion.div
          className={cn("h-full rounded-full", color)}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}

// ─── Connection Card ──────────────────────────────────────────────────────────
const GAME_CONNECT_HINTS: Record<string, string> = {
  minecraft: "Open Minecraft → Multiplayer → Add Server → paste the address below",
  "minecraft-java": "Open Minecraft Java Edition → Multiplayer → Add Server",
  "minecraft-bedrock": "Open Minecraft → Play → Servers → Add Server (port may differ)",
  terraria: "Open Terraria → Multiplayer → Join via IP → paste address & port",
  valheim: "In Steam: View → Servers → Add Server → paste address:port (primary UDP port)",
  cs2: "In CS2 console: connect <address>:<port>",
  rust: "In Rust: press F1 → client.connect <address>:<port>",
  ark: "Open ARK → Join ARK → Session Filter → search by IP",
  factorio: "Factorio → Multiplayer → Connect to address → paste address:port",
};

const QUICK_COMMANDS: Record<string, Array<{ label: string; cmd: string; color?: string }>> = {
  minecraft: [
    { label: "List players", cmd: "list" },
    { label: "Save world", cmd: "save-all" },
    { label: "Time day", cmd: "time set day" },
    { label: "Weather clear", cmd: "weather clear" },
    { label: "Broadcast", cmd: "say " },
    { label: "Difficulty", cmd: "difficulty peaceful" },
  ],
  terraria: [
    { label: "List players", cmd: "playing" },
    { label: "Save world", cmd: "save" },
    { label: "Broadcast", cmd: "say " },
  ],
  valheim: [
    { label: "List players", cmd: "players" },
    { label: "Save world", cmd: "save" },
  ],
};

function ConnectCard({
  nodeIp, allPorts, gameType,
}: { nodeIp: string | null; allPorts: ServicePort[]; gameType: string }) {
  const host = nodeIp ?? "—";
  const hint = GAME_CONNECT_HINTS[gameType] ?? "Connect using the address and port below";

  const primaryPort = allPorts.find(p => p.nodePort) ?? null;
  const primaryAddress = primaryPort ? `${host}:${primaryPort.nodePort}` : host;

  return (
    <div className="rounded-xl border border-[#1e3a5f] bg-[#0a1929] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wifi className="w-4 h-4 text-[#0078D4]" />
        <p className="text-xs font-semibold text-[#4fc3f7] uppercase tracking-wide">How to Connect</p>
      </div>

      {/* Primary copy box */}
      <div className="flex items-center gap-2">
        <div className="flex-1 font-mono text-sm text-[#e0e0e0] bg-[#0d1b2a] border border-[#1e3a5f] rounded-lg px-3 py-2 truncate">
          {primaryAddress}
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(primaryAddress); toast.success("Copied!"); }}
          className="flex-shrink-0 p-2 rounded-lg border border-[#1e3a5f] hover:bg-[#0d2137] text-[#4fc3f7] transition-colors"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* All ports table */}
      {allPorts.length > 0 && (
        <div className="space-y-1">
          {allPorts.map((p, i) => {
            const addr = `${host}:${p.nodePort ?? p.port}`;
            return (
              <div key={i} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn(
                    "px-1.5 py-0.5 rounded text-[10px] font-mono flex-shrink-0",
                    p.protocol === "UDP" ? "bg-purple-900/40 text-purple-300 border border-purple-700/40"
                      : "bg-blue-900/40 text-blue-300 border border-blue-700/40"
                  )}>{p.protocol}</span>
                  {p.name && <span className="text-[#555] capitalize">{p.name.replace(/-/g, " ")}</span>}
                  <span className="text-[#888] font-mono truncate">{addr}</span>
                </div>
                <button
                  onClick={() => { navigator.clipboard.writeText(addr); toast.success("Copied!"); }}
                  className="flex-shrink-0 text-[#555] hover:text-[#4fc3f7] transition-colors p-0.5"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Hint */}
      <p className="text-[11px] text-[#4a6fa5] leading-relaxed">{hint}</p>
    </div>
  );
}

// ─── Dashboard Tab ─────────────────────────────────────────────────────────────
function DashboardTab({ server, status, name }: { server: ServerDetail; status: string; name: string }) {
  const { data: events, isLoading: eventsLoading } = useQuery({
    queryKey: ["game-hub", "events-preview", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}/events`).catch(() => null);
      if (res?.ok) return res.json() as Promise<{ events: GameEvent[] }>;
      return { events: [] };
    },
    refetchInterval: 30000,
  });

  const statusColor = { running: "text-green-400", starting: "text-yellow-400", stopped: "text-[#666]" }[status];
  const dotColor = { running: "bg-green-400", starting: "bg-yellow-400 animate-pulse", stopped: "bg-[#555]" }[status];

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: Circle, label: "Status", value: status, color: statusColor, dot: dotColor },
          { icon: Network, label: "Game Port", value: server.nodePort?.toString() ?? server.port?.toString() ?? "—" },
          { icon: MemoryStick, label: "Memory", value: server.memory || "—" },
          { icon: Cpu, label: "CPU", value: server.cpu || "—" },
        ].map((item, i) => (
          <div key={i} className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
            <div className="flex items-center gap-1.5 mb-2">
              {item.dot ? (
                <span className={cn("w-2 h-2 rounded-full flex-shrink-0", item.dot)} />
              ) : (
                <item.icon className="w-3.5 h-3.5 text-[#555]" />
              )}
              <p className="text-[10px] text-[#555] uppercase tracking-wide">{item.label}</p>
            </div>
            <p className={cn("text-sm font-semibold capitalize truncate", item.color ?? "text-[#f2f2f2]")}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Resource gauges */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
        <p className="text-xs font-medium text-[#888] uppercase tracking-wide flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5" /> Resource Configuration
        </p>
        <ResourceBar label="Memory Limit" value={server.memory} color="bg-[#0078D4]" />
        <ResourceBar label="CPU Limit" value={server.cpu} color="bg-purple-500" />
      </div>

      {/* Pod info */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
        <p className="text-xs font-medium text-[#888] uppercase tracking-wide mb-3 flex items-center gap-1.5">
          <Gamepad2 className="w-3.5 h-3.5" /> Server Info
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            { label: "Game Type", value: server.gameType?.replace(/-/g, " ") || "—" },
            { label: "Pod", value: server.podName ?? "—" },
            { label: "Phase", value: server.podPhase ?? "—" },
            { label: "Uptime", value: server.podStartTime ? null : "—", component: server.podStartTime ? <Uptime startTime={server.podStartTime} /> : null },
            { label: "Created", value: server.createdAt ? new Date(server.createdAt).toLocaleDateString() : "—" },
          ].map((item, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 border-b border-[#1a1a1a] last:border-0">
              <span className="text-xs text-[#555]">{item.label}</span>
              <span className="text-xs text-[#9e9e9e] font-mono capitalize truncate max-w-[150px]">
                {item.component ?? item.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* How to Connect */}
      <ConnectCard nodeIp={server.nodeIp} allPorts={server.allPorts} gameType={server.gameType} />

      {/* Recent activity */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1e1e1e] flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Recent Events</p>
        </div>
        {eventsLoading ? (
          <div className="flex items-center justify-center h-16"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
        ) : (events?.events.length ?? 0) === 0 ? (
          <div className="flex items-center justify-center h-16 text-xs text-[#555]">No recent events</div>
        ) : (
          <div className="divide-y divide-[#1a1a1a]">
            {events?.events.slice(0, 6).map((ev, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0",
                  ev.type === "Warning" ? "bg-yellow-400" : "bg-green-400")} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[#d4d4d4]">{ev.reason}</span>
                    <span className="text-[10px] text-[#444] flex-shrink-0">{ev.timestamp}</span>
                  </div>
                  <p className="text-[11px] text-[#666] mt-0.5 truncate">{ev.message}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Console Tab ──────────────────────────────────────────────────────────────
function ConsoleTab({ name, status, gameType }: { name: string; status: string; gameType: string }) {
  const isMinecraft = ["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"]
    .includes(gameType.toLowerCase());
  const [logLines, setLogLines] = useState<Array<{ type: string; line: string; id: number }>>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [podLabel, setPodLabel] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const historyIdxRef = useRef(-1);
  const quickCommands = isMinecraft
    ? QUICK_COMMANDS.minecraft
    : QUICK_COMMANDS[gameType.toLowerCase()] ?? [];

  const addLine = useCallback((type: string, line: string) => {
    setLogLines(prev => [...prev.slice(-1000), { type, line, id: logIdRef.current++ }]);
  }, []);

  const connect = useCallback(() => {
    if (status === "stopped") return;
    if (retryRef.current) clearTimeout(retryRef.current);
    esRef.current?.close();
    const es = new EventSource(`/api/game-hub/servers/${name}/logs?tail=200`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; line?: string; pod?: string; container?: string };
        if (msg.type === "connected") {
          retryCountRef.current = 0;
          setConnected(true);
          setPodLabel(msg.pod ?? name);
          addLine("system", `▶ Connected to ${msg.pod ?? name}`);
        } else if (msg.type === "log" && msg.line) {
          addLine("log", msg.line);
        } else if (msg.type === "error" && msg.line) {
          addLine("error", msg.line);
        }
      } catch { /* keep-alive ping */ }
    };
    es.onerror = () => {
      setConnected(false);
      es.close();
      const delay = Math.min(2000 * Math.pow(2, retryCountRef.current), 30000);
      retryCountRef.current++;
      addLine("system", `⚠ Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`);
      retryRef.current = setTimeout(connect, delay);
    };
  }, [name, status, addLine]);

  useEffect(() => {
    if (status === "stopped") {
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
      setConnected(false);
      return;
    }
    retryCountRef.current = 0;
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      esRef.current?.close();
    };
  }, [name, status, connect]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  async function sendCommand(e: React.FormEvent) {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd || sending) return;
    if (cmd.length > 512) { toast.error("Command too long (max 512 chars)"); return; }
    setSending(true);
    setCommand("");
    historyIdxRef.current = -1;
    setHistory(prev => [cmd, ...prev.slice(0, 49)]);
    addLine("input", `❯ ${cmd}`);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/command`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json() as { stdout?: string; stderr?: string; error?: string };
      if (data.error) addLine("error", data.error);
      if (data.stdout) data.stdout.split("\n").filter(Boolean).forEach(l => addLine("output", l));
      if (data.stderr) data.stderr.split("\n").filter(Boolean).forEach(l => addLine("error", l));
    } catch (err) { addLine("error", String(err)); }
    finally { setSending(false); inputRef.current?.focus(); }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdxRef.current + 1, history.length - 1);
      historyIdxRef.current = next;
      setCommand(history[next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = next;
      setCommand(next < 0 ? "" : (history[next] ?? ""));
    }
  }

  const lineColor = (t: string) => ({
    system: "text-blue-400/80", error: "text-red-400",
    input: "text-yellow-300", output: "text-cyan-300",
  }[t] ?? "text-[#ccc]");

  return (
    <div className="flex flex-col rounded-xl border border-[#2a2a2a] bg-[#0a0a0a] overflow-hidden"
      style={{ height: "calc(100vh - 280px)", minHeight: "360px" }}>
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-[#111] border-b border-[#1e1e1e] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Circle className={cn("w-2 h-2", connected ? "fill-green-400 text-green-400" : "fill-[#444] text-[#444]")} />
          <span className={cn("text-xs", connected ? "text-green-400" : "text-[#555]")}>
            {connected ? podLabel : status === "stopped" ? "Server stopped" : "Connecting…"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {!connected && status !== "stopped" && (
            <button onClick={() => { retryCountRef.current = 0; connect(); }}
              className="text-xs text-[#0078D4] hover:underline">Reconnect</button>
          )}
          <div className="flex items-center gap-1">
            {[
              { icon: RefreshCw, label: "Clear", action: () => setLogLines([]) },
              { icon: Copy, label: "Copy all", action: () => { navigator.clipboard.writeText(logLines.map(l => l.line).join("\n")); toast.success("Copied"); } },
              { icon: Download, label: "Download logs", action: () => {
                const blob = new Blob([logLines.map(l => l.line).join("\n")], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${name}-console-${new Date().toISOString().slice(0,10)}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              } },
            ].map(({ icon: Icon, label, action }) => (
              <button key={label} onClick={action} title={label}
                className="p-1.5 text-[#444] hover:text-[#888] hover:bg-[#1e1e1e] rounded transition-colors">
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Log output */}
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-[1.7] overscroll-contain select-text">
        {status === "stopped" ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[#444]">
            <Square className="w-8 h-8" />
            <p>Server is stopped</p>
          </div>
        ) : logLines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#444] pt-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Connecting to log stream…</span>
          </div>
        ) : logLines.map(({ type, line, id }) => (
          <div key={id} className={cn("whitespace-pre-wrap break-all", lineColor(type))}>{line}</div>
        ))}
        <div ref={logEndRef} />
      </div>

      {connected && quickCommands.length > 0 && (
        <div className="flex-shrink-0 px-3 py-2 border-t border-[#1a1a1a] bg-[#0d0d0d]">
          <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">Quick commands</p>
          <div className="flex gap-1.5 flex-wrap">
            {quickCommands.map(q => (
              <button key={q.cmd} onClick={() => { setCommand(q.cmd); inputRef.current?.focus(); }}
                className="px-2.5 py-1 rounded text-[10px] bg-[#1a1a1a] hover:bg-[#252525] border border-[#2a2a2a] text-[#777] hover:text-[#ccc] transition-colors">
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Command input */}
      <div className="flex-shrink-0 border-t border-[#1a1a1a] p-2 bg-[#0d0d0d]">
        <form onSubmit={sendCommand} className="flex gap-2">
          <div className={cn(
            "flex-1 flex items-center gap-2 bg-[#111] border rounded-lg px-3 min-h-[46px]",
            connected ? "border-[#2a2a2a] focus-within:border-[#0078D4]" : "border-[#1a1a1a] opacity-50"
          )}>
            <span className="text-green-500 font-mono text-sm select-none flex-shrink-0">❯</span>
            <input ref={inputRef}
              value={command} onChange={e => setCommand(e.target.value)} onKeyDown={handleKeyDown}
              placeholder={connected
                ? isMinecraft ? "help, list, say Hello… (↑↓ history)" : "shell command… (↑↓ history)"
                : "Waiting for connection…"}
              disabled={!connected || sending}
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              // font-size 16px prevents iOS auto-zoom
              className="flex-1 bg-transparent text-[16px] leading-none font-mono text-[#f0f0f0] outline-none placeholder:text-[#333] disabled:cursor-not-allowed py-1"
            />
          </div>
          <button type="submit" disabled={!connected || sending || !command.trim()}
            className="flex items-center justify-center w-[50px] min-h-[46px] bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-25 text-white rounded-lg transition-colors touch-manipulation flex-shrink-0">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
        <p className="text-[10px] text-[#2a2a2a] mt-1.5 px-1">
          {isMinecraft ? "Minecraft RCON — type commands without /  •  ↑↓ for history" : "Shell access — commands run in container  •  ↑↓ for history"}
        </p>
      </div>
    </div>
  );
}

// ─── Files Tab ────────────────────────────────────────────────────────────────
function FilesTab({ name, status, mountPath }: { name: string; status: string; mountPath: string }) {
  const [currentPath, setCurrentPath] = useState(mountPath);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [pathHistory, setPathHistory] = useState<string[]>([mountPath]);
  const [mobilePane, setMobilePane] = useState<"files" | "editor">("files");

  const { data: listing, isLoading, refetch } = useQuery({
    queryKey: ["game-hub", "files", name, currentPath],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}/files?path=${encodeURIComponent(currentPath)}`);
      if (!res.ok) throw new Error("Failed to list files");
      return res.json() as Promise<{ files: FileEntry[] }>;
    },
    enabled: status !== "stopped",
    retry: 1,
  });

  const fileExt = selectedFile?.name.split(".").pop()?.toLowerCase() ?? "";
  const editorLang = ({ json: "json", yaml: "yaml", yml: "yaml", properties: "ini", conf: "ini", cfg: "ini", log: "plaintext", txt: "plaintext", sh: "shell", py: "python", js: "javascript", ts: "typescript", xml: "xml", toml: "toml" } as Record<string, string>)[fileExt] ?? "plaintext";

  async function openFile(entry: FileEntry) {
    if (entry.type === "directory") {
      setPathHistory(h => [...h, entry.path]);
      setCurrentPath(entry.path);
      setSelectedFile(null); setFileContent(null);
      return;
    }
    setSelectedFile(entry); setFileContent(null); setLoadingContent(true);
    setMobilePane("editor");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(
        `/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(entry.path)}`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { content: string };
      setFileContent(data.content);
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? "File load timed out — server may be busy"
        : String(err);
      toast.error(msg);
    } finally {
      clearTimeout(timer);
      setLoadingContent(false);
    }
  }

  async function saveFile() {
    if (!selectedFile || fileContent === null) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/files/content`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile.path, content: fileContent }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("File saved");
    } catch (err) { toast.error(String(err)); }
    finally { setSaving(false); }
  }

  async function deleteFile(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/files?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success(`${entry.name} deleted`);
      if (selectedFile?.path === entry.path) { setSelectedFile(null); setFileContent(null); }
      refetch();
    } catch (err) { toast.error(String(err)); }
  }

  function goUp() {
    if (pathHistory.length <= 1) return;
    const h = pathHistory.slice(0, -1);
    setPathHistory(h); setCurrentPath(h[h.length - 1]);
    setSelectedFile(null); setFileContent(null);
  }

  if (status === "stopped") return (
    <div className="flex flex-col items-center justify-center h-40 gap-3 text-[#555]">
      <FolderOpen className="w-8 h-8" />
      <p className="text-sm">Start the server to browse files</p>
    </div>
  );

  const sortedFiles = listing?.files.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  }) ?? [];

  const fileTree = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 bg-[#111] rounded-lg border border-[#2a2a2a] px-2 py-1.5">
        <button onClick={goUp} disabled={pathHistory.length <= 1}
          className="p-1 rounded hover:bg-[#1e1e1e] disabled:opacity-30 transition-colors flex-shrink-0">
          <ArrowUp className="w-3.5 h-3.5 text-[#666]" />
        </button>
        <span className="flex-1 min-w-0 truncate font-mono text-[10px] text-[#555]">{currentPath}</span>
        <button onClick={() => refetch()} className="p-1 rounded hover:bg-[#1e1e1e] transition-colors flex-shrink-0">
          <RefreshCw className="w-3 h-3 text-[#555]" />
        </button>
      </div>
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
        ) : sortedFiles.length === 0 ? (
          <p className="text-xs text-[#555] text-center py-6">Empty directory</p>
        ) : (
          <div className="p-1 max-h-[55vh] overflow-y-auto overscroll-contain">
            {sortedFiles.map(entry => (
              <div key={entry.path}
                onClick={() => openFile(entry)}
                className={cn("group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors text-xs touch-manipulation",
                  selectedFile?.path === entry.path
                    ? "bg-[rgba(0,120,212,0.2)] text-white"
                    : "hover:bg-[#1a1a1a] text-[#9e9e9e]")}>
                {entry.type === "directory"
                  ? <Folder className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                  : <File className="w-3.5 h-3.5 text-[#444] flex-shrink-0" />}
                <span className="truncate flex-1">{entry.name}</span>
                {entry.type !== "directory" && (
                  <button onClick={e => { e.stopPropagation(); deleteFile(entry); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-[#444] hover:text-red-400 transition-all">
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const editorPane = (
    <div className="flex flex-col gap-2">
      {selectedFile ? (
        <>
          <div className="flex items-center gap-2">
            <button onClick={() => setMobilePane("files")} className="md:hidden flex items-center gap-1 text-xs text-[#0078D4] flex-shrink-0">
              ← Files
            </button>
            <span className="text-xs text-[#555] font-mono truncate flex-1 min-w-0">{selectedFile.path}</span>
            <button onClick={() => { navigator.clipboard.writeText(fileContent ?? ""); toast.success("Copied"); }}
              className="p-1.5 text-[#444] hover:text-[#888] flex-shrink-0"><Copy className="w-3.5 h-3.5" /></button>
            <button onClick={saveFile} disabled={saving || loadingContent}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex-shrink-0">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
            </button>
          </div>
          <div className="rounded-xl border border-[#2a2a2a] overflow-hidden" style={{ height: "55vh", minHeight: "300px" }}>
            {loadingContent ? (
              <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-[#555]" /></div>
            ) : (
              <MonacoEditor height="100%" language={editorLang} value={fileContent ?? ""}
                onChange={v => setFileContent(v ?? "")} theme="vs-dark"
                options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", wordWrap: "on", scrollBeyondLastLine: false, padding: { top: 8 } }} />
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#111] gap-3" style={{ height: "55vh", minHeight: "200px" }}>
          <FolderOpen className="w-10 h-10 text-[#2a2a2a]" />
          <p className="text-sm text-[#555]">Select a file to edit</p>
          <button onClick={() => setMobilePane("files")} className="md:hidden text-xs text-[#0078D4]">Browse files →</button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="hidden md:grid grid-cols-[260px_1fr] gap-4">{fileTree}{editorPane}</div>
      <div className="md:hidden space-y-3">
        <div className="flex gap-1 p-1 bg-[#111] rounded-lg border border-[#2a2a2a]">
          {(["files", "editor"] as const).map(p => (
            <button key={p} onClick={() => setMobilePane(p)}
              className={cn("flex-1 py-2.5 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1.5",
                mobilePane === p ? "bg-[#0078D4] text-white" : "text-[#666]")}>
              {p === "files" ? <Folder className="w-3.5 h-3.5" /> : <File className="w-3.5 h-3.5" />}
              {p === "editor" && selectedFile ? selectedFile.name : p === "files" ? "Files" : "Editor"}
            </button>
          ))}
        </div>
        {mobilePane === "files" ? fileTree : editorPane}
      </div>
    </>
  );
}

function ActivityTab({ name }: { name: string }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["game-hub", "events", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}/events`);
      if (!res.ok) throw new Error("Failed to load events");
      return res.json() as Promise<{ events: GameEvent[] }>;
    },
    refetchInterval: 30000,
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#555] uppercase tracking-wide font-medium">Recent Events</p>
        <button onClick={() => refetch()} className="p-1 text-[#444] hover:text-[#888]">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
        ) : !data?.events.length ? (
          <div className="py-10 text-center text-[#444] text-sm">No recent events</div>
        ) : (
          <div className="divide-y divide-[#1e1e1e]">
            {data.events.map((event, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <span className={cn("w-2 h-2 rounded-full mt-1.5 flex-shrink-0",
                  event.type === "Warning" ? "bg-yellow-400" : "bg-green-400")} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-[#f2f2f2]">{event.reason}</span>
                    {event.count > 1 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#252525] text-[#666] border border-[#333]">
                        ×{event.count}
                      </span>
                    )}
                    <span className="text-[10px] text-[#444] ml-auto">
                      {event.timestamp ? new Date(event.timestamp).toLocaleString() : "—"}
                    </span>
                  </div>
                  <p className="text-xs text-[#666] mt-0.5 break-words">{event.message}</p>
                  <p className="text-[10px] text-[#333] mt-0.5">{event.involvedKind}/{event.involvedName}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
function SettingsTab({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();

  // ── Replica control state ──
  const [replicaMode, setReplicaMode] = useState<"static" | "dynamic">(server.hpa.enabled ? "dynamic" : "static");
  const [staticCount, setStaticCount] = useState(server.replicas ?? 1);
  const [hpaMin, setHpaMin] = useState(server.hpa.min);
  const [hpaMax, setHpaMax] = useState(server.hpa.max);
  const [hpaCpu, setHpaCpu] = useState(server.hpa.cpuTarget ?? 70);
  const [scaleSaving, setScaleSaving] = useState(false);
  const [autoRestart, setAutoRestart] = useState(server.restartPolicy !== "OnFailure");
  const [savingRestart, setSavingRestart] = useState(false);
  const [notes, setNotes] = useState(server.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [memLimit, setMemLimit] = useState(server.memory ?? "");
  const [cpuLimit, setCpuLimit] = useState(server.cpu ?? "");
  const [savingResources, setSavingResources] = useState(false);

  async function saveReplicas() {
    setScaleSaving(true);
    try {
      if (replicaMode === "static") {
        const res = await fetch(`/api/game-hub/servers/${name}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "scale", replicas: staticCount }),
        });
        if (!res.ok) throw new Error("Scale failed");
        toast.success(`Set to ${staticCount} replica${staticCount !== 1 ? "s" : ""}`);
      } else {
        const res = await fetch(`/api/game-hub/servers/${name}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-hpa", hpaMin, hpaMax, hpaCpuTarget: hpaCpu }),
        });
        if (!res.ok) throw new Error("HPA save failed");
        toast.success(`Auto-scale enabled: ${hpaMin}–${hpaMax} replicas @ ${hpaCpu}% CPU`);
      }
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) { toast.error(String(err)); }
    finally { setScaleSaving(false); }
  }

  async function toggleAutoRestart() {
    const next = !autoRestart;
    setSavingRestart(true);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-restart-policy", restartPolicy: next }),
      });
      if (!res.ok) throw new Error("Restart policy update failed");
      setAutoRestart(next);
      toast.success(next ? "Crash restart enabled" : "Crash restart limited to failures only");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingRestart(false);
    }
  }

  async function saveNotes() {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-notes", notes }),
      });
      if (!res.ok) throw new Error("Notes save failed");
      toast.success("Server notes saved");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveResources() {
    const memory = memLimit.trim();
    const cpu = cpuLimit.trim();
    if (!memory || !cpu) {
      toast.error("Memory and CPU limits are required");
      return;
    }
    setSavingResources(true);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-resources", memory, cpu }),
      });
      if (!res.ok) throw new Error("Resource update failed");
      toast.success("Resource limits updated");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingResources(false);
    }
  }

  const [editingEnv, setEditingEnv] = useState(false);
  const [envStr, setEnvStr] = useState(
    server.env.map(e => `${e.name}=${e.value ?? ""}`).join("\n")
  );
  const [saving, setSaving] = useState(false);

  async function saveEnv() {
    setSaving(true);
    try {
      const env: Record<string, string> = {};
      for (const line of envStr.split("\n")) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-env", env }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("Saved — restart the server to apply changes");
      setEditingEnv(false);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) { toast.error(String(err)); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      {/* ── Replica / Scaling Control ── */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Layers className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Replica Scaling</p>
          {server.hpa.enabled && (
            <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/20">HPA active</span>
          )}
        </div>
        <div className="p-4 space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-2">
            {(["static", "dynamic"] as const).map(m => (
              <button key={m} onClick={() => setReplicaMode(m)}
                className={cn("flex-1 py-2 rounded-lg text-xs font-medium transition-colors border",
                  replicaMode === m
                    ? "bg-[#0078D4]/20 border-[#0078D4]/50 text-[#0078D4]"
                    : "bg-transparent border-[#2a2a2a] text-[#666] hover:text-[#888]")}>
                {m === "static" ? "Static (fixed)" : "Dynamic (HPA)"}
              </button>
            ))}
          </div>

          {replicaMode === "static" ? (
            <div className="flex items-center gap-3">
              <label className="text-xs text-[#666] flex-shrink-0">Replicas</label>
              <div className="flex items-center gap-1">
                <button onClick={() => setStaticCount(c => Math.max(0, c - 1))}
                  className="w-7 h-7 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] text-sm font-bold flex items-center justify-center">−</button>
                <span className="w-8 text-center text-sm font-mono text-[#f2f2f2]">{staticCount}</span>
                <button onClick={() => setStaticCount(c => Math.min(10, c + 1))}
                  className="w-7 h-7 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] text-sm font-bold flex items-center justify-center">+</button>
              </div>
              <p className="text-[10px] text-[#444]">(0 = stopped, max 10)</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">Min replicas</label>
                  <input type="number" min={1} max={10} value={hpaMin}
                    onChange={e => setHpaMin(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">Max replicas</label>
                  <input type="number" min={1} max={10} value={hpaMax}
                    onChange={e => setHpaMax(Math.max(hpaMin, parseInt(e.target.value) || 1))}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">CPU target %</label>
                  <input type="number" min={10} max={100} value={hpaCpu}
                    onChange={e => setHpaCpu(Math.min(100, Math.max(10, parseInt(e.target.value) || 70)))}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]" />
                </div>
              </div>
              {server.hpa.currentReplicas !== null && (
                <p className="text-[10px] text-[#555]">Currently running {server.hpa.currentReplicas} replica(s) via HPA</p>
              )}
            </div>
          )}

          <button onClick={saveReplicas} disabled={scaleSaving}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
            {scaleSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Apply scaling
          </button>
        </div>
      </div>

      {/* Auto-restart policy */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <RotateCcw className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Auto-restart Policy</p>
        </div>
        <div className="p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#f2f2f2]">Restart on crash</p>
            <p className="text-xs text-[#555] mt-0.5">Automatically restart if the server process exits unexpectedly</p>
          </div>
          <button onClick={toggleAutoRestart} disabled={savingRestart}
            className={cn("relative w-11 h-6 rounded-full transition-colors flex-shrink-0",
              autoRestart ? "bg-[#0078D4]" : "bg-[#2a2a2a]")}>
            <span className={cn("absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow",
              autoRestart ? "translate-x-5" : "translate-x-0")} />
          </button>
        </div>
      </div>

      {/* Server notes */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-[#555]" />
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Server Notes</p>
          </div>
          <button onClick={saveNotes} disabled={savingNotes} className="text-xs text-[#0078D4] hover:underline">
            {savingNotes ? "Saving..." : "Save"}
          </button>
        </div>
        <div className="p-4">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
            placeholder="Add notes about this server, connection info, admin contacts..."
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4] placeholder:text-[#333]" />
        </div>
      </div>

      {/* Resource Limits */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Cpu className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Resource Limits</p>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-[#666] mb-1">Memory limit</label>
              <input value={memLimit} onChange={e => setMemLimit(e.target.value)}
                placeholder="e.g. 2Gi, 512Mi"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1">CPU limit</label>
              <input value={cpuLimit} onChange={e => setCpuLimit(e.target.value)}
                placeholder="e.g. 1, 500m"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" />
            </div>
          </div>
          <button onClick={saveResources} disabled={savingResources}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
            {savingResources ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Apply limits
          </button>
        </div>
      </div>

      {/* Environment variables */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <Shield className="w-3.5 h-3.5 text-[#555]" />
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Environment Variables</p>
          </div>
          <button onClick={() => setEditingEnv(!editingEnv)} className="text-xs text-[#0078D4] hover:underline">
            {editingEnv ? "Cancel" : "Edit"}
          </button>
        </div>
        <div className="p-4">
          {editingEnv ? (
            <div className="space-y-3">
              <p className="text-xs text-[#555]">One <code className="text-[#888]">KEY=VALUE</code> per line. Sensitive values are hidden in the display view.</p>
              <textarea value={envStr} onChange={e => setEnvStr(e.target.value)} rows={12}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm font-mono text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4] leading-relaxed" />
              <button onClick={saveEnv} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save changes
              </button>
            </div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {server.env.length === 0 ? (
                <p className="text-xs text-[#555]">No environment variables set.</p>
              ) : server.env.map(e => (
                <div key={e.name} className="flex items-start gap-2 text-xs py-0.5">
                  <span className="font-mono text-[#0078D4] flex-shrink-0 min-w-[120px]">{e.name}</span>
                  <span className="text-[#444]">=</span>
                  <span className={cn("font-mono break-all", e.name.match(/PASS|SECRET|KEY|TOKEN/i) ? "text-[#444] italic" : "text-[#9e9e9e]")}>
                    {e.name.match(/PASS|SECRET|KEY|TOKEN/i) ? "••••••••" : (e.value ?? "<from secret>")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Danger zone */}
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
        <div className="px-4 py-3 border-b border-red-500/20">
          <p className="text-xs font-medium text-red-400/80 uppercase tracking-wide">Danger Zone</p>
        </div>
        <div className="p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#f2f2f2]">Delete this server</p>
            <p className="text-xs text-[#666] mt-0.5">Permanently removes the deployment and all data. This cannot be undone.</p>
          </div>
          <button
            onClick={async () => {
              if (!confirm(`Permanently delete ${name} and all its data? This cannot be undone.`)) return;
              try {
                const res = await fetch(`/api/game-hub/servers/${name}`, { method: "DELETE" });
                if (!res.ok) throw new Error("Delete failed");
                toast.success(`${name} deleted`);
                window.location.href = "/game-hub";
              } catch (err) { toast.error(String(err)); }
            }}
            className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium transition-colors">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ServerDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: server, isLoading, error, refetch } = useQuery({
    queryKey: ["game-hub", "server", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}`);
      if (!res.ok) {
        // Try to get the error detail from the response body
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<ServerDetail>;
    },
    refetchInterval: 10000,
    retry: 2,
  });

  async function doAction(action: string) {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`${action} failed`);
      toast.success(`${action} successful`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) { toast.error(String(err)); }
    finally { setActionLoading(null); }
  }

  const status = server?.readyReplicas && server.readyReplicas > 0 ? "running"
    : (server?.replicas ?? 0) > 0 ? "starting" : "stopped";

  // Map each game type to the container path where its data PVC is mounted
  const GAME_MOUNT_PATHS: Record<string, string> = {
    minecraft: "/data", "minecraft-java": "/data", "minecraft-bedrock": "/data",
    terraria: "/world",
    valheim: "/config",
    satisfactory: "/config",
    "project-zomboid": "/data",
    vrising: "/config",
    palworld: "/data",
    ark: "/data",
    rust: "/data",
    cs2: "/data",
    factorio: "/data",
  };
  const mountPath = GAME_MOUNT_PATHS[server?.gameType ?? ""] ?? "/data";

  const statusDot = { running: "bg-green-400", starting: "bg-yellow-400 animate-pulse", stopped: "bg-[#444]" }[status];
  const statusText = { running: "text-green-400", starting: "text-yellow-400", stopped: "text-[#666]" }[status];

  const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "console", label: "Console", icon: Terminal },
    { id: "files", label: "Files", icon: FolderOpen },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="space-y-0 pb-2">
      {/* ── Server header ── */}
      <div className="sticky top-0 z-10 bg-[#0e0e0e]/95 backdrop-blur-sm border-b border-[#1e1e1e] -mx-4 px-4 pb-0 pt-0">
        {/* Top row */}
        <div className="flex items-center gap-2 py-3">
          <Link href="/game-hub"
            className="p-1.5 rounded-lg text-[#555] hover:text-[#9e9e9e] hover:bg-[#1e1e1e] transition-colors flex-shrink-0">
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <span className="text-xl flex-shrink-0">{GAME_ICONS[server?.gameType ?? ""] ?? "🎮"}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-[#f2f2f2] truncate">{name}</h1>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className={cn("w-2 h-2 rounded-full flex-shrink-0", statusDot)} />
                <span className={cn("text-xs capitalize hidden sm:block", statusText)}>{status}</span>
              </div>
            </div>
            <p className="text-[10px] text-[#555] capitalize">{server?.gameType?.replace(/-/g, " ") ?? "Game"} Server</p>
          </div>
          {/* Action buttons */}
          {server && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {status === "stopped" ? (
                <button onClick={() => doAction("start")} disabled={!!actionLoading}
                  className="flex items-center gap-1.5 px-3 py-2 min-h-[38px] bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 rounded-lg text-xs font-medium disabled:opacity-50 touch-manipulation">
                  {actionLoading === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  Start
                </button>
              ) : (
                <>
                  <button onClick={() => doAction("restart")} disabled={!!actionLoading} title="Restart"
                    className="p-2 min-h-[38px] min-w-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center">
                    {actionLoading === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => doAction("stop")} disabled={!!actionLoading} title="Stop"
                    className="p-2 min-h-[38px] min-w-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center">
                    {actionLoading === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-0 overflow-x-auto scrollbar-none touch-pan-x">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap flex-shrink-0 touch-manipulation",
                activeTab === id
                  ? "border-[#0078D4] text-[#0078D4] bg-[#0078D4]/5"
                  : "border-transparent text-[#555] hover:text-[#888]"
              )}>
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="pt-4">
        {isLoading && (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
            <p className="text-xs text-[#555]">Loading server details…</p>
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-300">Could not load server details</p>
              <p className="text-xs text-red-400/80 mt-1 font-mono">{String(error)}</p>
              <button onClick={() => refetch()}
                className="mt-3 flex items-center gap-1.5 text-xs text-red-300 hover:underline">
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </div>
          </div>
        )}

        {server && !isLoading && (
          <AnimatePresence mode="wait">
            <motion.div key={activeTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}>
              {activeTab === "dashboard" && <DashboardTab server={server} status={status} name={name} />}
              {activeTab === "console" && <ConsoleTab name={name} status={status} gameType={server?.gameType ?? "unknown"} />}
              {activeTab === "files" && <FilesTab name={name} status={status} mountPath={mountPath} />}
              {activeTab === "activity" && <ActivityTab name={name} />}
              {activeTab === "settings" && <SettingsTab name={name} server={server} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
