"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ChevronLeft, Play, Square, RotateCcw, Loader2, Terminal,
  Settings, FolderOpen, Activity, File, Folder, Save, Trash2,
  RefreshCw, Copy, ArrowUp, Send, Circle, AlertTriangle,
  Gamepad2, Cpu, MemoryStick, Network
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import Link from "next/link";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const GAME_ICONS: Record<string, string> = {
  minecraft: "⛏", "minecraft-java": "⛏", "minecraft-bedrock": "⛏",
  terraria: "🌍", valheim: "🪓", cs2: "🔫", rust: "🔩", ark: "🦕",
  factorio: "⚙️", satisfactory: "🏭", "project-zomboid": "🧟",
  vrising: "🧛", palworld: "🦎", "dont-starve-together": "🕯️",
  "seven-days-to-die": "💀", "team-fortress-2": "🎩", "garrys-mod": "🔧",
};

interface ServerDetail {
  name: string; gameType: string; replicas: number; readyReplicas: number;
  podName: string | null; podPhase: string | null; podStartTime: string | null;
  port: number | null; nodePort: number | null; memory: string; cpu: string;
  env: Array<{ name: string; value: string }>; createdAt: string | null;
}

interface FileEntry {
  name: string; path: string; type: "file" | "directory" | "symlink" | "other";
  size: number; modifiedAt: string; permissions: string;
}

type TabId = "files" | "activity" | "settings" | "info";

// ─── Inline Console (always visible) ─────────────────────────────────────────
function ConsolePanel({ name, status }: { name: string; status: string }) {
  const [logLines, setLogLines] = useState<Array<{ type: string; line: string; id: number }>>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [podInfo, setPodInfo] = useState<string>("");
  const logEndRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  const addLine = useCallback((type: string, line: string) => {
    setLogLines(prev => [...prev.slice(-500), { type, line, id: logIdRef.current++ }]);
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
          setPodInfo(msg.pod ?? name);
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
      retryCountRef.current += 1;
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
    if (!command.trim() || sending) return;
    setSending(true);
    const cmd = command;
    setCommand("");
    addLine("input", `$ ${cmd}`);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/command`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json() as { stdout?: string; stderr?: string; error?: string };
      if (data.stdout) data.stdout.split("\n").filter(Boolean).forEach(l => addLine("output", l));
      if (data.stderr) data.stderr.split("\n").filter(Boolean).forEach(l => addLine("error", l));
      if (data.error) addLine("error", data.error);
    } catch (err) { addLine("error", String(err)); }
    finally { setSending(false); }
  }

  const lineColor = (t: string) => ({
    system: "text-blue-400", error: "text-red-400",
    input: "text-yellow-300", output: "text-cyan-300",
  }[t] ?? "text-[#d4d4d4]");

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] overflow-hidden">
      {/* Console header bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[#161616] border-b border-[#2a2a2a]">
        <Terminal className="w-3.5 h-3.5 text-[#555]" />
        <span className="text-xs font-medium text-[#888]">Console</span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Circle className={cn("w-2 h-2", connected ? "fill-green-400 text-green-400" : "fill-[#444] text-[#444]")} />
            <span className={cn("text-[10px]", connected ? "text-green-400" : "text-[#555]")}>
              {connected ? podInfo : status === "stopped" ? "Stopped" : "Connecting…"}
            </span>
          </div>
          {!connected && status !== "stopped" && (
            <button onClick={() => { retryCountRef.current = 0; connect(); }}
              className="text-[10px] text-[#0078D4] hover:underline">Retry</button>
          )}
          {logLines.length > 0 && (
            <button onClick={() => setLogLines([])}
              className="text-[#444] hover:text-[#888] transition-colors" title="Clear">
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Log output */}
      <div className="h-[300px] sm:h-[380px] overflow-y-auto p-3 font-mono text-xs leading-[1.6] overscroll-contain">
        {status === "stopped" ? (
          <div className="flex items-center gap-2 text-[#555] italic pt-2">
            <Square className="w-3 h-3" />
            <span>Server is stopped — start it to stream logs</span>
          </div>
        ) : logLines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#555] pt-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Connecting to log stream…</span>
          </div>
        ) : (
          <>
            {logLines.map(({ type, line, id }) => (
              <div key={id} className={cn("whitespace-pre-wrap break-all", lineColor(type))}>
                {line}
              </div>
            ))}
          </>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Command input */}
      <div className="border-t border-[#1e1e1e] p-2">
        <form onSubmit={sendCommand} className="flex gap-2">
          <div className={cn(
            "flex-1 flex items-center gap-2 bg-[#111] border rounded-lg px-3 min-h-[44px]",
            connected ? "border-[#2a2a2a]" : "border-[#1e1e1e] opacity-60"
          )}>
            <span className="text-green-500 font-mono text-xs select-none">›</span>
            <input
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder={connected ? "Type a server command…" : status === "stopped" ? "Start server first" : "Waiting for connection…"}
              disabled={!connected || sending}
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className="flex-1 bg-transparent text-sm font-mono text-[#f2f2f2] outline-none placeholder:text-[#3a3a3a] disabled:cursor-not-allowed"
            />
          </div>
          <button type="submit" disabled={!connected || sending || !command.trim()}
            className="flex items-center justify-center gap-1.5 w-[52px] min-h-[44px] bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg transition-colors touch-manipulation flex-shrink-0">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Files Panel ──────────────────────────────────────────────────────────────
function FilesPanel({ name, status, mountPath }: { name: string; status: string; mountPath: string }) {
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
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(entry.path)}`);
      if (!res.ok) throw new Error("Cannot read file");
      const data = await res.json() as { content: string };
      setFileContent(data.content);
    } catch (err) { toast.error(String(err)); }
    finally { setLoadingContent(false); }
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
    <div className="flex items-center justify-center h-24 text-[#555] text-sm">Server must be running to browse files</div>
  );

  const fileTree = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-xs text-[#666]">
        <button onClick={goUp} disabled={pathHistory.length <= 1}
          className="p-1.5 rounded hover:bg-[#252525] disabled:opacity-30 transition-colors">
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
        <span className="truncate font-mono flex-1 min-w-0 text-[10px]">{currentPath}</span>
        <button onClick={() => refetch()} className="p-1.5 rounded hover:bg-[#252525] transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
        ) : (listing?.files.length === 0) ? (
          <p className="text-xs text-[#555] text-center py-6">Empty directory</p>
        ) : (
          <div className="p-1 space-y-0.5 max-h-[50vh] overflow-y-auto">
            {listing?.files.sort((a, b) => {
              if (a.type === "directory" && b.type !== "directory") return -1;
              if (a.type !== "directory" && b.type === "directory") return 1;
              return a.name.localeCompare(b.name);
            }).map(entry => (
              <div key={entry.path}
                className={cn("group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors text-xs touch-manipulation",
                  selectedFile?.path === entry.path ? "bg-[rgba(0,120,212,0.2)] text-[#f2f2f2]" : "hover:bg-[#1e1e1e] text-[#9e9e9e]")}
                onClick={() => openFile(entry)}>
                {entry.type === "directory"
                  ? <Folder className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                  : <File className="w-3.5 h-3.5 text-[#555] flex-shrink-0" />}
                <span className="truncate flex-1">{entry.name}</span>
                {entry.type !== "directory" && (
                  <button onClick={e => { e.stopPropagation(); deleteFile(entry); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-[#555] hover:text-red-400 transition-all flex-shrink-0">
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
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setMobilePane("files")}
              className="md:hidden flex items-center gap-1 text-xs text-[#0078D4]">
              ← Files
            </button>
            <span className="text-xs text-[#666] font-mono truncate flex-1 min-w-0">{selectedFile.name}</span>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => { navigator.clipboard.writeText(fileContent ?? ""); toast.success("Copied"); }}
                className="p-1.5 text-[#555] hover:text-[#999]"><Copy className="w-3.5 h-3.5" /></button>
              <button onClick={saveFile} disabled={saving || loadingContent}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-[#2a2a2a] overflow-hidden h-[300px] sm:h-[400px]">
            {loadingContent ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin text-[#555]" />
              </div>
            ) : (
              <MonacoEditor height="100%" language={editorLang} value={fileContent ?? ""}
                onChange={v => setFileContent(v ?? "")} theme="vs-dark"
                options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", wordWrap: "on", scrollBeyondLastLine: false, padding: { top: 8 } }} />
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#111] h-[200px] gap-2">
          <FolderOpen className="w-8 h-8 text-[#333]" />
          <p className="text-sm text-[#555]">Select a file to edit</p>
          <button onClick={() => setMobilePane("files")} className="md:hidden text-xs text-[#0078D4]">Browse files →</button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: side-by-side */}
      <div className="hidden md:grid grid-cols-[260px_1fr] gap-4">{fileTree}{editorPane}</div>
      {/* Mobile: tab switcher */}
      <div className="md:hidden space-y-3">
        <div className="flex gap-1 p-1 bg-[#151515] rounded-lg border border-[#2a2a2a]">
          {(["files", "editor"] as const).map(p => (
            <button key={p} onClick={() => setMobilePane(p)}
              className={cn("flex-1 py-2 rounded text-xs font-medium transition-colors capitalize flex items-center justify-center gap-1.5",
                mobilePane === p ? "bg-[#0078D4] text-white" : "text-[#666]")}>
              {p === "files" ? <Folder className="w-3.5 h-3.5" /> : <File className="w-3.5 h-3.5" />}
              {p === "editor" && selectedFile ? selectedFile.name : p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        {mobilePane === "files" ? fileTree : editorPane}
      </div>
    </>
  );
}

// ─── Activity Panel ───────────────────────────────────────────────────────────
function ActivityPanel({ name }: { name: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["game-hub", "activity", name],
    queryFn: async () => {
      const res = await fetch(`/api/k8s/events?namespace=game-hub&name=${name}`).catch(() => null);
      if (res?.ok) return res.json() as Promise<{ events: Array<{ type: string; reason: string; message: string; timestamp: string }> }>;
      return { events: [] };
    },
    refetchInterval: 15000,
  });

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] divide-y divide-[#1e1e1e]">
      {isLoading ? (
        <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
      ) : (data?.events.length ?? 0) === 0 ? (
        <div className="flex items-center justify-center h-20 text-sm text-[#555]">No recent events</div>
      ) : data?.events.map((ev, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0", ev.type === "Warning" ? "bg-yellow-400" : "bg-green-400")} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-[#f2f2f2]">{ev.reason}</span>
              <span className="text-[10px] text-[#555]">{ev.timestamp}</span>
            </div>
            <p className="text-xs text-[#9e9e9e] mt-0.5 break-words">{ev.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  const [editingEnv, setEditingEnv] = useState(false);
  const [envStr, setEnvStr] = useState(server.env.map(e => `${e.name}=${e.value}`).join("\n"));
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
      toast.success("Environment variables updated — restart to apply");
      setEditingEnv(false);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) { toast.error(String(err)); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[#f2f2f2]">Environment Variables</p>
          <button onClick={() => setEditingEnv(!editingEnv)} className="text-xs text-[#0078D4] hover:underline">
            {editingEnv ? "Cancel" : "Edit"}
          </button>
        </div>
        {editingEnv ? (
          <div className="space-y-2">
            <p className="text-xs text-[#666]">One KEY=VALUE per line</p>
            <textarea value={envStr} onChange={e => setEnvStr(e.target.value)} rows={10}
              className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg p-3 text-xs font-mono text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4]" />
            <button onClick={saveEnv} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] text-white rounded-lg text-xs font-medium disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {server.env.map(e => (
              <div key={e.name} className="flex items-start gap-2 text-xs">
                <span className="font-mono text-[#0078D4] flex-shrink-0">{e.name}</span>
                <span className="text-[#555]">=</span>
                <span className={cn("font-mono break-all", e.name.match(/PASS|SECRET|KEY/) ? "text-[#555] italic" : "text-[#9e9e9e]")}>
                  {e.name.match(/PASS|SECRET|KEY/) ? "••••••" : e.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ServerDetailPage({ params }: { params: { name: string } }) {
  const { name } = params;
  const [activeTab, setActiveTab] = useState<TabId>("files");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: server, isLoading, error, refetch } = useQuery({
    queryKey: ["game-hub", "server", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
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

  const mountPath = server?.gameType === "valheim" || server?.gameType === "satisfactory" ? "/config" : "/data";

  const statusDot = { running: "bg-green-400", starting: "bg-yellow-400 animate-pulse", stopped: "bg-[#555]" }[status];
  const statusText = { running: "text-green-400", starting: "text-yellow-400", stopped: "text-[#666]" }[status];

  const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
    { id: "files", label: "Files", icon: FolderOpen },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "info", label: "Info", icon: Gamepad2 },
  ];

  return (
    <div className="space-y-4 pb-2">
      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <Link href="/game-hub" className="p-2 rounded-lg text-[#666] hover:text-[#9e9e9e] hover:bg-[#1e1e1e] transition-colors flex-shrink-0">
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div className="text-2xl">{GAME_ICONS[server?.gameType ?? ""] ?? "🎮"}</div>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-[#f2f2f2] truncate">{name}</h1>
          <p className="text-xs text-[#666] capitalize">{server?.gameType?.replace(/-/g, " ") ?? "Game"} Server</p>
        </div>
        {/* Action buttons in header for quick access */}
        {server && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {status === "stopped" ? (
              <button onClick={() => doAction("start")} disabled={!!actionLoading}
                className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 touch-manipulation">
                {actionLoading === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                Start
              </button>
            ) : (
              <>
                <button onClick={() => doAction("restart")} disabled={!!actionLoading}
                  className="p-2.5 min-h-[40px] min-w-[40px] bg-[#1e1e1e] hover:bg-[#252525] text-[#9e9e9e] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center">
                  {actionLoading === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => doAction("stop")} disabled={!!actionLoading}
                  className="p-2.5 min-h-[40px] min-w-[40px] bg-[#1e1e1e] hover:bg-[#252525] text-[#9e9e9e] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center">
                  {actionLoading === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Loading ── */}
      {isLoading && (
        <div className="flex items-center justify-center h-32">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
            <p className="text-xs text-[#555]">Loading server…</p>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && !isLoading && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-300">Could not load server details</p>
            <p className="text-xs text-red-400/70 mt-1">{String(error)}</p>
            <button onClick={() => refetch()} className="mt-3 text-xs text-red-300 hover:underline flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        </div>
      )}

      {server && !isLoading && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          {/* ── Status row ── */}
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#151515] border border-[#222]">
            <div className="flex items-center gap-2">
              <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", statusDot)} />
              <span className={cn("text-sm font-semibold capitalize", statusText)}>{status}</span>
            </div>
            <div className="h-4 w-px bg-[#2a2a2a]" />
            <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap">
              {server.nodePort && <span className="flex items-center gap-1"><Network className="w-3 h-3" /> :{server.nodePort}</span>}
              {server.memory && <span className="flex items-center gap-1"><MemoryStick className="w-3 h-3" /> {server.memory}</span>}
              {server.cpu && <span className="flex items-center gap-1 hidden sm:flex"><Cpu className="w-3 h-3" /> {server.cpu}</span>}
            </div>
          </div>

          {/* ── CONSOLE — always visible, never in a tab ── */}
          <ConsolePanel name={name} status={status} />

          {/* ── Secondary tabs ── */}
          <div className="flex gap-1 border-b border-[#2a2a2a] overflow-x-auto scrollbar-none">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setActiveTab(id)}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap flex-shrink-0",
                  activeTab === id ? "border-[#0078D4] text-[#0078D4]" : "border-transparent text-[#666] hover:text-[#9e9e9e]"
                )}>
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* ── Tab content ── */}
          <div>
            {activeTab === "files" && <FilesPanel name={name} status={status} mountPath={mountPath} />}
            {activeTab === "activity" && <ActivityPanel name={name} />}
            {activeTab === "settings" && <SettingsPanel name={name} server={server} />}
            {activeTab === "info" && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {[
                    { label: "Game Port", value: server.port?.toString() ?? "—" },
                    { label: "Node Port", value: server.nodePort?.toString() ?? "—" },
                    { label: "Pod Phase", value: server.podPhase ?? "—" },
                    { label: "Memory", value: server.memory || "—" },
                    { label: "CPU", value: server.cpu || "—" },
                    { label: "Pod", value: server.podName ?? "—" },
                  ].map(item => (
                    <div key={item.label} className="rounded-xl border border-[#2a2a2a] bg-[#111] p-3">
                      <p className="text-[10px] text-[#555] uppercase tracking-wide mb-1">{item.label}</p>
                      <p className="text-xs font-medium text-[#f2f2f2] truncate">{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
