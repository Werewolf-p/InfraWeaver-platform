"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Gamepad2, ChevronLeft, Play, Square, RotateCcw, Loader2, Terminal,
  Settings, FolderOpen, Activity, ChevronRight, ChevronDown, File,
  Folder, Save, Trash2, RefreshCw, AlertTriangle, Copy, Download,
  ArrowUp, Send, Circle
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
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
  name: string;
  gameType: string;
  replicas: number;
  readyReplicas: number;
  podName: string | null;
  podPhase: string | null;
  podStartTime: string | null;
  port: number | null;
  nodePort: number | null;
  memory: string;
  cpu: string;
  env: Array<{ name: string; value: string }>;
  createdAt: string | null;
}

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
  permissions: string;
}

type TabId = "overview" | "console" | "files" | "activity" | "settings";

// ── Console Tab ───────────────────────────────────────────────────────────────
function ConsoleTab({ name, status }: { name: string; status: string }) {
  const [logLines, setLogLines] = useState<Array<{ type: string; line: string; id: number }>>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [podInfo, setPodInfo] = useState<{ pod: string; container: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  const addLine = useCallback((type: string, line: string) => {
    setLogLines(prev => [...prev.slice(-500), { type, line, id: logIdRef.current++ }]);
  }, []);

  useEffect(() => {
    if (status === "stopped") return;

    const es = new EventSource(`/api/game-hub/servers/${name}/logs?tail=200`);

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; line?: string; pod?: string; container?: string };
        if (msg.type === "connected") {
          setConnected(true);
          setPodInfo({ pod: msg.pod ?? "", container: msg.container ?? "" });
          addLine("system", `Connected to ${msg.pod} (${msg.container})`);
        } else if (msg.type === "log" && msg.line) {
          addLine("log", msg.line);
        } else if (msg.type === "error" && msg.line) {
          addLine("error", msg.line);
        }
      } catch {}
    };

    es.onerror = () => {
      setConnected(false);
      addLine("error", "Log stream disconnected — retrying...");
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [name, status, addLine]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  async function sendCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!command.trim() || sending) return;
    setSending(true);
    const cmd = command;
    setCommand("");
    addLine("input", `> ${cmd}`);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json() as { stdout?: string; stderr?: string; error?: string };
      if (data.stdout) data.stdout.split("\n").filter(Boolean).forEach(l => addLine("output", l));
      if (data.stderr) data.stderr.split("\n").filter(Boolean).forEach(l => addLine("error", l));
      if (data.error) addLine("error", data.error);
    } catch (err) {
      addLine("error", String(err));
    } finally {
      setSending(false);
    }
  }

  const lineColor = (type: string) => {
    if (type === "system") return "text-blue-400";
    if (type === "error") return "text-red-400";
    if (type === "input") return "text-yellow-300";
    if (type === "output") return "text-cyan-300";
    return "text-[#d4d4d4]";
  };

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-22rem)]">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#151515] border border-[#2a2a2a] text-xs">
        <Circle className={cn("w-2 h-2", connected ? "fill-green-400 text-green-400" : "fill-[#555] text-[#555]")} />
        <span className={connected ? "text-green-400" : "text-[#666]"}>
          {connected ? `Connected — ${podInfo?.pod}` : status === "stopped" ? "Server is stopped" : "Connecting..."}
        </span>
        {logLines.length > 0 && (
          <button onClick={() => setLogLines([])} className="ml-auto text-[#555] hover:text-[#999] transition-colors">
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Log area */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#0a0a0a] p-3 font-mono text-xs leading-5">
        {status === "stopped" ? (
          <p className="text-[#555] italic">Server is stopped. Start it to see logs.</p>
        ) : logLines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#555]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Connecting to log stream...</span>
          </div>
        ) : (
          logLines.map(({ type, line, id }) => (
            <div key={id} className={cn("whitespace-pre-wrap break-all", lineColor(type))}>
              {line}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>

      {/* Command input */}
      <form onSubmit={sendCommand} className="flex gap-2">
        <div className="flex-1 flex items-center gap-2 bg-[#151515] border border-[#2a2a2a] rounded-lg px-3 py-2">
          <span className="text-green-400 font-mono text-xs">$</span>
          <input
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder={connected ? "Enter server command..." : "Server must be running..."}
            disabled={!connected || sending}
            className="flex-1 bg-transparent text-xs font-mono text-[#f2f2f2] outline-none placeholder:text-[#555] disabled:opacity-50"
          />
        </div>
        <button
          type="submit"
          disabled={!connected || sending || !command.trim()}
          className="flex items-center gap-1.5 px-3 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
        >
          {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Send
        </button>
      </form>
    </div>
  );
}

// ── File Manager Tab ──────────────────────────────────────────────────────────
function FilesTab({ name, status, mountPath }: { name: string; status: string; mountPath: string }) {
  const [currentPath, setCurrentPath] = useState(mountPath);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [pathHistory, setPathHistory] = useState<string[]>([mountPath]);

  const { data: listing, isLoading, refetch } = useQuery({
    queryKey: ["game-hub", "files", name, currentPath],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}/files?path=${encodeURIComponent(currentPath)}`);
      if (!res.ok) throw new Error("Failed to list files");
      return res.json() as Promise<{ path: string; files: FileEntry[] }>;
    },
    enabled: status !== "stopped",
    retry: 1,
  });

  async function openFile(entry: FileEntry) {
    if (entry.type === "directory") {
      setPathHistory(h => [...h, entry.path]);
      setCurrentPath(entry.path);
      setSelectedFile(null);
      setFileContent(null);
      return;
    }
    setSelectedFile(entry);
    setFileContent(null);
    setLoadingContent(true);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(entry.path)}`);
      if (!res.ok) throw new Error("Cannot read file");
      const data = await res.json() as { content: string };
      setFileContent(data.content);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoadingContent(false);
    }
  }

  async function saveFile() {
    if (!selectedFile || fileContent === null) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile.path, content: fileContent }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("File saved");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteFile(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      const res = await fetch(`/api/game-hub/servers/${name}/files?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success(`${entry.name} deleted`);
      if (selectedFile?.path === entry.path) { setSelectedFile(null); setFileContent(null); }
      refetch();
    } catch (err) {
      toast.error(String(err));
    }
  }

  function goUp() {
    if (pathHistory.length <= 1) return;
    const newHistory = pathHistory.slice(0, -1);
    setPathHistory(newHistory);
    setCurrentPath(newHistory[newHistory.length - 1]);
    setSelectedFile(null);
    setFileContent(null);
  }

  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const fileExt = selectedFile?.name.split(".").pop()?.toLowerCase() ?? "";
  const editorLang = { json: "json", yaml: "yaml", yml: "yaml", properties: "ini", conf: "ini", cfg: "ini", log: "plaintext", txt: "plaintext", sh: "shell", py: "python", js: "javascript", ts: "typescript", xml: "xml", toml: "toml" }[fileExt] ?? "plaintext";

  if (status === "stopped") {
    return (
      <div className="flex items-center justify-center h-40 text-[#555] text-sm">
        Server must be running to browse files
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-22rem)]">
      {/* File tree */}
      <div className="w-64 flex-shrink-0 flex flex-col gap-2 overflow-hidden">
        {/* Breadcrumb + up */}
        <div className="flex items-center gap-1 text-xs text-[#666] truncate">
          <button onClick={goUp} disabled={pathHistory.length <= 1} className="text-[#555] hover:text-[#999] disabled:opacity-30 transition-colors flex-shrink-0">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <span className="truncate font-mono">{currentPath}</span>
          <button onClick={() => refetch()} className="ml-auto text-[#555] hover:text-[#999] flex-shrink-0">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-1">
          {isLoading ? (
            <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
          ) : (listing?.files.length === 0) ? (
            <p className="text-xs text-[#555] text-center py-4">Empty directory</p>
          ) : (
            <div className="space-y-0.5">
              {listing?.files
                .sort((a, b) => {
                  if (a.type === "directory" && b.type !== "directory") return -1;
                  if (a.type !== "directory" && b.type === "directory") return 1;
                  return a.name.localeCompare(b.name);
                })
                .map(entry => (
                  <div
                    key={entry.path}
                    className={cn(
                      "group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-xs",
                      selectedFile?.path === entry.path
                        ? "bg-[rgba(0,120,212,0.2)] text-[#f2f2f2]"
                        : "hover:bg-[#252525] text-[#9e9e9e]"
                    )}
                    onClick={() => openFile(entry)}
                  >
                    {entry.type === "directory"
                      ? <Folder className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                      : <File className="w-3.5 h-3.5 text-[#666] flex-shrink-0" />
                    }
                    <span className="truncate flex-1">{entry.name}</span>
                    {entry.type !== "directory" && (
                      <button
                        onClick={e => { e.stopPropagation(); deleteFile(entry); }}
                        className="opacity-0 group-hover:opacity-100 text-[#555] hover:text-red-400 transition-all flex-shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))
              }
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col gap-2 min-w-0">
        {selectedFile ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#666] font-mono truncate">{selectedFile.path}</span>
              <span className="text-xs text-[#555]">({(selectedFile.size / 1024).toFixed(1)} KB)</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => { navigator.clipboard.writeText(fileContent ?? ""); toast.success("Copied"); }}
                  className="text-xs text-[#555] hover:text-[#999] flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" /> Copy
                </button>
                <button
                  onClick={saveFile}
                  disabled={saving || loadingContent}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
              </div>
            </div>
            <div className="flex-1 rounded-xl border border-[#2a2a2a] overflow-hidden">
              {loadingContent ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-5 h-5 animate-spin text-[#555]" />
                </div>
              ) : (
                <MonacoEditor
                  height="100%"
                  language={editorLang}
                  value={fileContent ?? ""}
                  onChange={v => setFileContent(v ?? "")}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    lineNumbers: "on",
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    padding: { top: 8 },
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#1a1a1a]">
            <div className="text-center space-y-2">
              <FolderOpen className="w-8 h-8 text-[#333] mx-auto" />
              <p className="text-sm text-[#555]">Select a file to edit</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity Tab ──────────────────────────────────────────────────────────────
function ActivityTab({ name }: { name: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["game-hub", "activity", name],
    queryFn: async () => {
      const k8sRes = await fetch(`/api/k8s/events?namespace=game-hub&name=${name}`).catch(() => null);
      if (k8sRes?.ok) return k8sRes.json() as Promise<{ events: Array<{ type: string; reason: string; message: string; timestamp: string }> }>;
      return { events: [] };
    },
    refetchInterval: 15000,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] divide-y divide-[#2a2a2a]">
        {isLoading ? (
          <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
        ) : (data?.events.length ?? 0) === 0 ? (
          <div className="flex items-center justify-center h-20 text-sm text-[#555]">No recent events</div>
        ) : (
          data?.events.map((ev, i) => (
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
          ))
        )}
      </div>
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────────
function SettingsTab({ name, server }: { name: string; server: ServerDetail }) {
  const [editingEnv, setEditingEnv] = useState(false);
  const queryClient = useQueryClient();
  const [envStr, setEnvStr] = useState(
    server.env.map(e => `${e.name}=${e.value}`).join("\n")
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
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-env", env }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("Environment variables updated — restart to apply");
      setEditingEnv(false);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[#f2f2f2]">Environment Variables</p>
          <button
            onClick={() => setEditingEnv(!editingEnv)}
            className="text-xs text-[#0078D4] hover:underline"
          >
            {editingEnv ? "Cancel" : "Edit"}
          </button>
        </div>

        {editingEnv ? (
          <div className="space-y-2">
            <p className="text-xs text-[#666]">One KEY=VALUE per line</p>
            <textarea
              value={envStr}
              onChange={e => setEnvStr(e.target.value)}
              rows={12}
              className="w-full bg-[#111] border border-[#333] rounded-lg p-3 text-xs font-mono text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4]"
            />
            <button
              onClick={saveEnv}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save &amp; restart server to apply
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {server.env.map(e => (
              <div key={e.name} className="flex items-start gap-2 text-xs">
                <span className="font-mono text-[#0078D4] flex-shrink-0 min-w-[120px]">{e.name}</span>
                <span className="text-[#555]">=</span>
                <span className={cn(
                  "font-mono break-all",
                  e.name.includes("PASS") || e.name.includes("SECRET") || e.name.includes("KEY")
                    ? "text-[#555] italic" : "text-[#9e9e9e]"
                )}>
                  {e.name.includes("PASS") || e.name.includes("SECRET") || e.name.includes("KEY") ? "••••••" : e.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4">
        <p className="text-sm font-medium text-[#f2f2f2] mb-3">Advanced</p>
        <div className="space-y-2">
          <Link
            href={`/config?namespace=game-hub&resource=deployment&name=${name}`}
            className="flex items-center gap-2 text-xs text-[#0078D4] hover:underline"
          >
            <Settings className="w-3.5 h-3.5" />
            Edit Deployment YAML directly
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ServerDetailPage({ params }: { params: { name: string } }) {
  const { name } = params;
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: server, isLoading } = useQuery({
    queryKey: ["game-hub", "server", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}`);
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<ServerDetail>;
    },
    refetchInterval: 10000,
  });

  async function doAction(action: string) {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`${action} failed`);
      toast.success(`${action} successful`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setActionLoading(null);
    }
  }

  const status = server?.readyReplicas && server.readyReplicas > 0 ? "running"
    : (server?.replicas ?? 0) > 0 ? "starting" : "stopped";

  const statusColors = {
    running: { dot: "bg-green-400", text: "text-green-400", border: "border-green-500/20", bg: "bg-green-500/5" },
    starting: { dot: "bg-yellow-400 animate-pulse", text: "text-yellow-400", border: "border-yellow-500/20", bg: "bg-yellow-500/5" },
    stopped: { dot: "bg-[#555]", text: "text-[#666]", border: "border-[#2a2a2a]", bg: "bg-[#1a1a1a]" },
  };
  const sc = statusColors[status as keyof typeof statusColors];

  const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
    { id: "overview", label: "Overview", icon: Activity },
    { id: "console", label: "Console", icon: Terminal },
    { id: "files", label: "Files", icon: FolderOpen },
    { id: "activity", label: "Activity", icon: AlertTriangle },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  // Default mount path by game type
  const mountPath = (() => {
    const gt = server?.gameType ?? name;
    if (gt === "valheim") return "/config";
    if (gt === "satisfactory") return "/config";
    return "/data";
  })();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/game-hub" className="text-[#666] hover:text-[#9e9e9e] transition-colors p-1">
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div className="text-2xl">{GAME_ICONS[server?.gameType ?? ""] ?? "🎮"}</div>
        <div>
          <h1 className="text-lg font-semibold text-[#f2f2f2]">{name}</h1>
          <p className="text-xs text-[#666] capitalize">{server?.gameType?.replace(/-/g, " ") ?? "game"} server</p>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
        </div>
      )}

      {server && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
          {/* Status card */}
          <div className={cn("flex items-center gap-4 p-4 rounded-xl border", sc.border, sc.bg)}>
            <div className="flex items-center gap-2 flex-1">
              <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", sc.dot)} />
              <span className={cn("text-sm font-semibold capitalize", sc.text)}>{status}</span>
              <span className="text-xs text-[#555] ml-1">•</span>
              <span className="text-xs text-[#666]">Port {server.nodePort ?? "—"}</span>
              <span className="text-xs text-[#555] hidden sm:inline">• {server.memory} RAM • {server.cpu} CPU</span>
            </div>
            <div className="flex items-center gap-2">
              {status === "stopped" ? (
                <button
                  onClick={() => doAction("start")}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {actionLoading === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  Start
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => doAction("stop")}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "stop" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                    <span className="hidden sm:inline">Stop</span>
                  </button>
                  <button
                    onClick={() => doAction("restart")}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "restart" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    <span className="hidden sm:inline">Restart</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex overflow-x-auto border-b border-[#2a2a2a] scrollbar-none">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap",
                  activeTab === id
                    ? "border-[#0078D4] text-[#0078D4]"
                    : "border-transparent text-[#666] hover:text-[#9e9e9e]"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {activeTab === "overview" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: "Status", value: status },
                      { label: "Game Port", value: server.port?.toString() ?? "—" },
                      { label: "Node Port", value: server.nodePort?.toString() ?? "—" },
                      { label: "Pod Phase", value: server.podPhase ?? "—" },
                    ].map(item => (
                      <div key={item.label} className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4">
                        <p className="text-xs text-[#666] mb-1">{item.label}</p>
                        <p className="text-sm font-medium text-[#f2f2f2] capitalize">{item.value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4">
                    <p className="text-xs text-[#666] mb-3 font-medium uppercase tracking-wide">Environment Variables</p>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {server.env.map(e => (
                        <div key={e.name} className="flex items-start gap-2 text-xs">
                          <span className="font-mono text-[#0078D4] flex-shrink-0">{e.name}</span>
                          <span className="text-[#555]">=</span>
                          <span className={cn(
                            "font-mono break-all",
                            e.name.includes("PASS") || e.name.includes("SECRET") ? "text-[#555] italic" : "text-[#9e9e9e]"
                          )}>
                            {e.name.includes("PASS") || e.name.includes("SECRET") ? "••••••" : e.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "console" && <ConsoleTab name={name} status={status} />}

              {activeTab === "files" && <FilesTab name={name} status={status} mountPath={mountPath} />}

              {activeTab === "activity" && <ActivityTab name={name} />}

              {activeTab === "settings" && <SettingsTab name={name} server={server} />}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
