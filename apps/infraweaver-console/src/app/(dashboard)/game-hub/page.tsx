"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Gamepad2, Play, Square, RotateCcw, Trash2, Terminal, Loader2, AlertTriangle, HardDrive, X, CheckSquare, Square as SquareIcon, Search, ChevronDown, ChevronUp, BarChart2, BookOpen, Star, LayoutGrid, Rows3 } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import Link from "next/link";

interface GameServer {
  name: string;
  gameType: string;
  status: string;
  replicas: number;
  readyReplicas: number;
  podName: string | null;
  port: number;
  nodePort: number;
  memory: string;
  cpu: string;
  createdAt: string | null;
  description?: string;
  icon?: string;
  tags?: string[];
  groups?: string[];
  playerCount?: number;
  imageVersion?: string;
  imagePinned?: boolean;
  restartCount?: number;
  healthScore?: number;
  podStartTime?: string | null;
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  cpuLimit?: number | null;
  memoryLimit?: number | null;
  inGit: boolean;
}

interface UnusedPVC {
  namespace: string;
  name: string;
  status: string;
  storageClass: string;
  capacity: string;
  createdAt: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500/20 text-green-300 border-green-500/30",
  starting: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  stopped: "bg-[#333] text-[#999] border-[#444]",
  crashed: "bg-red-500/20 text-red-300 border-red-500/30",
};

const FEATURE_ROADMAP: Array<{ category: string; items: Array<{ name: string; status: "Shipped" | "Planned" | "Coming Soon" }> }> = [
  {
    category: "Server Management",
    items: [
      { name: "Start/Stop/Restart", status: "Shipped" },
      { name: "Env vars editor", status: "Shipped" },
      { name: "Static replicas", status: "Shipped" },
      { name: "HPA auto-scale", status: "Shipped" },
      { name: "Server delete", status: "Shipped" },
      { name: "Server clone", status: "Shipped" },
      { name: "Templates library", status: "Shipped" },
      { name: "Bulk start/stop", status: "Shipped" },
      { name: "Scheduled on/off", status: "Coming Soon" },
      { name: "Maintenance mode", status: "Coming Soon" },
    ],
  },
  {
    category: "Monitoring",
    items: [
      { name: "Status indicator", status: "Shipped" },
      { name: "Uptime counter", status: "Shipped" },
      { name: "CPU/RAM graphs", status: "Shipped" },
      { name: "Network traffic", status: "Shipped" },
      { name: "Player count timeline", status: "Shipped" },
      { name: "Server tick metrics", status: "Coming Soon" },
      { name: "Disk usage chart", status: "Shipped" },
      { name: "Event timeline", status: "Shipped" },
      { name: "Alert thresholds", status: "Coming Soon" },
      { name: "Performance score", status: "Shipped" },
    ],
  },
  {
    category: "Console",
    items: [
      { name: "Interactive console", status: "Shipped" },
      { name: "Command execution", status: "Shipped" },
      { name: "Command history", status: "Shipped" },
      { name: "Command templates", status: "Shipped" },
      { name: "Broadcast button", status: "Shipped" },
      { name: "Player kick/ban", status: "Shipped" },
      { name: "Whitelist editor", status: "Shipped" },
      { name: "Quick commands panel", status: "Shipped" },
      { name: "Console search", status: "Shipped" },
      { name: "Console export", status: "Shipped" },
    ],
  },
  {
    category: "File Management",
    items: [
      { name: "File browser", status: "Shipped" },
      { name: "Monaco editor", status: "Shipped" },
      { name: "File delete", status: "Shipped" },
      { name: "File upload", status: "Shipped" },
      { name: "File download", status: "Shipped" },
      { name: "Directory create", status: "Shipped" },
      { name: "File rename", status: "Shipped" },
      { name: "Permissions viewer", status: "Coming Soon" },
      { name: "Binary file viewer", status: "Shipped" },
      { name: "File diff", status: "Coming Soon" },
    ],
  },
  {
    category: "Backup & Recovery",
    items: [
      { name: "Manual world backup", status: "Shipped" },
      { name: "Scheduled backups", status: "Shipped" },
      { name: "Backup retention", status: "Shipped" },
      { name: "Restore from backup", status: "Coming Soon" },
      { name: "Cross-server transfer", status: "Coming Soon" },
      { name: "Backup size tracking", status: "Shipped" },
      { name: "Backup verification", status: "Coming Soon" },
      { name: "TrueNAS target", status: "Shipped" },
      { name: "S3 target", status: "Coming Soon" },
      { name: "Incremental backup", status: "Coming Soon" },
    ],
  },
  {
    category: "Networking",
    items: [
      { name: "Connection info", status: "Shipped" },
      { name: "Multi-port display", status: "Shipped" },
      { name: "Custom domain", status: "Planned" },
      { name: "DNS auto-register", status: "Coming Soon" },
      { name: "Player capacity", status: "Planned" },
      { name: "Bandwidth metering", status: "Coming Soon" },
      { name: "Firewall rules", status: "Coming Soon" },
      { name: "BungeeCord proxy", status: "Coming Soon" },
      { name: "Cloudflare tunnel", status: "Coming Soon" },
      { name: "Server ping", status: "Shipped" },
    ],
  },
  {
    category: "Player Management",
    items: [
      { name: "Online player list", status: "Shipped" },
      { name: "Whitelist editor", status: "Shipped" },
      { name: "Op management", status: "Shipped" },
      { name: "Ban list", status: "Shipped" },
      { name: "Player stats", status: "Shipped" },
      { name: "Discord webhooks", status: "Shipped" },
      { name: "GeoIP map", status: "Shipped" },
      { name: "Chat viewer", status: "Shipped" },
      { name: "Player history", status: "Shipped" },
      { name: "Player groups", status: "Shipped" },
    ],
  },
  {
    category: "Mods & Plugins",
    items: [
      { name: "Mod list viewer", status: "Shipped" },
      { name: "Plugin list", status: "Shipped" },
      { name: "Modrinth install", status: "Shipped" },
      { name: "Mod updater", status: "Coming Soon" },
      { name: "Mod conflicts", status: "Coming Soon" },
      { name: "Plugin config editor", status: "Shipped" },
      { name: "Mod packs", status: "Coming Soon" },
      { name: "Workshop integration", status: "Coming Soon" },
      { name: "Custom eggs", status: "Shipped" },
      { name: "Docker image picker", status: "Shipped" },
    ],
  },
  {
    category: "Storage",
    items: [
      { name: "Longhorn backend", status: "Shipped" },
      { name: "TrueNAS backend", status: "Shipped" },
      { name: "Synology backend", status: "Shipped" },
      { name: "ZFS snapshots", status: "Coming Soon" },
      { name: "PVC expansion", status: "Shipped" },
      { name: "Data migration", status: "Coming Soon" },
      { name: "IO benchmark", status: "Coming Soon" },
      { name: "Storage analytics", status: "Shipped" },
      { name: "Quota enforcement", status: "Coming Soon" },
      { name: "Tiered storage", status: "Coming Soon" },
    ],
  },
  {
    category: "RBAC & Security",
    items: [
      { name: "Platform RBAC", status: "Shipped" },
      { name: "Per-server roles", status: "Shipped" },
      { name: "IaC user assignments", status: "Shipped" },
      { name: "Audit log", status: "Shipped" },
      { name: "Command ACL", status: "Shipped" },
      { name: "File access control", status: "Shipped" },
      { name: "Two-factor auth", status: "Coming Soon" },
      { name: "API tokens", status: "Shipped" },
      { name: "Session management", status: "Shipped" },
      { name: "Security alerts", status: "Shipped" },
    ],
  },
];

const ROADMAP_STATUS_STYLES: Record<"Shipped" | "Planned" | "Coming Soon", string> = {
  Shipped: "bg-green-500/15 text-green-300 border-green-500/30",
  Planned: "bg-[#0078D4]/15 text-[#4db3ff] border-[#0078D4]/30",
  "Coming Soon": "bg-[#252525] text-[#999] border-[#333]",
};

function PVCCleanupModal({ onClose }: { onClose: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pvc-cleanup"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/pvcs/unused");
      if (!res.ok) throw new Error("Failed to fetch unused PVCs");
      const result = await res.json() as { unused: UnusedPVC[] };
      setChecked(new Set(result.unused.map((pvc) => `${pvc.namespace}/${pvc.name}`)));
      return result;
    },
    staleTime: 0,
  });

  const unused = data?.unused ?? [];

  function toggleAll() {
    if (checked.size === unused.length) setChecked(new Set());
    else setChecked(new Set(unused.map((pvc) => `${pvc.namespace}/${pvc.name}`)));
  }

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function doCleanup() {
    const toDelete = unused.filter((pvc) => checked.has(`${pvc.namespace}/${pvc.name}`));
    if (toDelete.length === 0) return;
    setDeleting(true);
    try {
      const results = await Promise.all(toDelete.map(async (pvc) => {
        const res = await fetch(`/api/game-hub/pvcs/${encodeURIComponent(pvc.name)}`, { method: "DELETE" });
        return { ok: res.ok, pvc };
      }));
      const deleted = results.filter((result) => result.ok).length;
      const failed = results.length - deleted;
      if (failed > 0) toast.error(`${failed} PVC(s) failed to delete`);
      if (deleted > 0) toast.success(`${deleted} PVC(s) deleted`);
      onClose();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a2a]">
          <div className="flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-[#0078D4]" />
            <div>
              <h2 className="text-sm font-semibold text-[#f2f2f2]">PVC Cleanup</h2>
              <p className="text-xs text-[#666] mt-0.5">Remove unused PersistentVolumeClaims</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#252525] text-[#666] hover:text-[#f2f2f2] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading && (
            <div className="flex items-center justify-center h-32 gap-2 text-[#666]">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Scanning PVCs...</span>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {String(error)}
            </div>
          )}
          {!isLoading && !error && unused.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 text-center gap-2">
              <div className="text-3xl">✅</div>
              <p className="text-sm text-[#f2f2f2] font-medium">No unused PVCs found</p>
              <p className="text-xs text-[#666]">All PersistentVolumeClaims are bound and in use</p>
            </div>
          )}
          {!isLoading && unused.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-[#666]">{unused.length} unused PVC{unused.length !== 1 ? "s" : ""} found</p>
                <button onClick={toggleAll} className="text-xs text-[#0078D4] hover:underline flex items-center gap-1">
                  {checked.size === unused.length ? <SquareIcon className="w-3 h-3" /> : <CheckSquare className="w-3 h-3" />}
                  {checked.size === unused.length ? "Deselect all" : "Select all"}
                </button>
              </div>
              {unused.map((pvc) => {
                const key = `${pvc.namespace}/${pvc.name}`;
                const isChecked = checked.has(key);
                return (
                  <button key={key} onClick={() => toggle(key)} className={cn("w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors", isChecked ? "bg-red-500/10 border-red-500/30 hover:bg-red-500/15" : "bg-[#252525] border-[#2a2a2a] hover:bg-[#2a2a2a]")}>
                    <div className={cn("mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center", isChecked ? "bg-red-500 border-red-500" : "border-[#444]")}>{isChecked && <span className="text-white text-[10px] font-bold">✓</span>}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-[#f2f2f2] truncate">{pvc.name}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0", pvc.status === "Released" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" : pvc.status === "Lost" ? "bg-red-500/20 text-red-300 border-red-500/30" : "bg-[#333] text-[#999] border-[#444]")}>{pvc.status}</span>
                      </div>
                      <p className="text-[11px] text-[#666] mt-0.5">{pvc.namespace} · {pvc.storageClass || "default"} · {pvc.capacity || "unknown size"}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {!isLoading && unused.length > 0 && (
          <div className="flex items-center justify-between gap-3 p-5 border-t border-[#2a2a2a]">
            <p className="text-xs text-[#666]">{checked.size} of {unused.length} selected</p>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] text-sm font-medium transition-colors">Cancel</button>
              <button onClick={doCleanup} disabled={checked.size === 0 || deleting} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete {checked.size > 0 ? `${checked.size} PVC${checked.size !== 1 ? "s" : ""}` : ""}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

type ServerSortKey = "name" | "status" | "cpu" | "players" | "started" | "health";
type ServerViewMode = "detailed" | "compact";
const SERVER_SORT_KEY = "infraweaver:game-hub-sort";
const SERVER_FAVORITES_KEY = "infraweaver:game-hub-favorites";
const SERVER_VIEW_KEY = "infraweaver:game-hub-view";

function computeHealthScore(server: GameServer) {
  const readyScore = server.readyReplicas > 0 ? 40 : 0;
  const restartPenalty = Math.min((server.restartCount ?? 0) * 5, 20);
  const cpuPct = server.cpuUsage && server.cpuLimit ? (server.cpuUsage / server.cpuLimit) * 100 : 0;
  const memoryPct = server.memoryUsage && server.memoryLimit ? (server.memoryUsage / server.memoryLimit) * 100 : 0;
  const cpuScore = cpuPct <= 0 ? 10 : cpuPct <= 80 ? 20 : cpuPct <= 95 ? 10 : 0;
  const memoryScore = memoryPct <= 0 ? 10 : memoryPct <= 80 ? 20 : memoryPct <= 95 ? 10 : 0;
  const ageHours = server.podStartTime ? (Date.now() - new Date(server.podStartTime).getTime()) / 3_600_000 : 0;
  const ageScore = !server.podStartTime ? 0 : ageHours >= 24 ? 20 : ageHours >= 1 ? 12 : 6;
  return Math.max(0, Math.min(100, readyScore + cpuScore + memoryScore + ageScore - restartPenalty));
}

function healthBadge(server: GameServer) {
  const score = computeHealthScore(server);
  if (server.status === "stopped") return { label: "Stopped", score, className: "bg-[#333] text-[#bbb] border-[#444]" };
  if (score >= 80) return { label: `${score}/100`, score, className: "bg-green-500/15 text-green-300 border-green-500/30" };
  if (score >= 50) return { label: `${score}/100`, score, className: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" };
  return { label: `${score}/100`, score, className: "bg-red-500/15 text-red-300 border-red-500/30" };
}

function formatUsage(value: number | null | undefined, limit: number | null | undefined, kind: "cpu" | "memory") {
  if (!value || !limit) return "—";
  const pct = Math.round((value / limit) * 100);
  if (kind === "cpu") return `${pct}%`;
  const gib = (value / (1024 ** 3)).toFixed(1);
  return `${gib}Gi (${pct}%)`;
}

function replicaSummary(server: GameServer) {
  if (server.readyReplicas === 0 && server.replicas === 0) return "—";
  return `${server.readyReplicas}/${server.replicas}`;
}

function formatUptime(startTime: string | null | undefined, now: number) {
  if (!startTime || !now) return "—";
  const diff = Math.max(0, Math.floor((now - new Date(startTime).getTime()) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

export default function GameHubPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showPVCCleanup, setShowPVCCleanup] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showRoadmap, setShowRoadmap] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compareMode, setCompareMode] = useState(false);
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());
  const [filterTag, setFilterTag] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem(SERVER_FAVORITES_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [viewMode, setViewMode] = useState<ServerViewMode>(() => {
    if (typeof window === "undefined") return "detailed";
    try {
      return localStorage.getItem(SERVER_VIEW_KEY) === "compact" ? "compact" : "detailed";
    } catch {
      return "detailed";
    }
  });
  const [sortKey, setSortKey] = useState<ServerSortKey>(() => {
    if (typeof window === "undefined") return "health";
    try {
      return (JSON.parse(localStorage.getItem(SERVER_SORT_KEY) ?? "{}")?.sortKey as ServerSortKey) ?? "health";
    } catch {
      return "health";
    }
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    if (typeof window === "undefined") return "desc";
    try {
      return JSON.parse(localStorage.getItem(SERVER_SORT_KEY) ?? "{}")?.sortDir === "asc" ? "asc" : "desc";
    } catch {
      return "desc";
    }
  });
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const immediate = setTimeout(tick, 0);
    const interval = setInterval(tick, 60000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    try {
      localStorage.setItem(SERVER_SORT_KEY, JSON.stringify({ sortKey, sortDir }));
    } catch {
      // ignore
    }
  }, [sortDir, sortKey]);

  useEffect(() => {
    try {
      localStorage.setItem(SERVER_FAVORITES_KEY, JSON.stringify([...favorites]));
    } catch {
      // ignore
    }
  }, [favorites]);

  useEffect(() => {
    try {
      localStorage.setItem(SERVER_VIEW_KEY, viewMode);
    } catch {
      // ignore
    }
  }, [viewMode]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["game-hub", "servers"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/servers");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<{ servers: GameServer[] }>;
    },
    refetchInterval: 15000,
  });

  const servers = data?.servers ?? [];
  const uniqueGameTypes = [...new Set(servers.map((server) => server.gameType))].sort();
  const allTags = [...new Set(servers.flatMap((server) => server.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const allGroups = [...new Set(servers.flatMap((server) => server.groups ?? []))].sort((a, b) => a.localeCompare(b));
  const filteredServers = [...servers.filter((server) => {
    const haystack = [server.name, server.description ?? "", ...(server.tags ?? []), ...(server.groups ?? [])].join(" ").toLowerCase();
    if (debouncedSearch && !haystack.includes(debouncedSearch.toLowerCase())) return false;
    if (filterStatus !== "all" && server.status !== filterStatus) return false;
    if (filterType && server.gameType !== filterType) return false;
    if (filterTag && !(server.tags ?? []).includes(filterTag)) return false;
    if (filterGroup && !(server.groups ?? []).includes(filterGroup)) return false;
    return true;
  })].sort((a, b) => {
    if (favorites.has(a.name) !== favorites.has(b.name)) return favorites.has(a.name) ? -1 : 1;
    const direction = sortDir === "asc" ? 1 : -1;
    if (sortKey === "health") return direction * (computeHealthScore(a) - computeHealthScore(b));
    if (sortKey === "started") return direction * ((a.podStartTime ? new Date(a.podStartTime).getTime() : 0) - (b.podStartTime ? new Date(b.podStartTime).getTime() : 0));
    if (sortKey === "cpu") return direction * ((a.cpuLimit && a.cpuUsage ? a.cpuUsage / a.cpuLimit : 0) - (b.cpuLimit && b.cpuUsage ? b.cpuUsage / b.cpuLimit : 0));
    if (sortKey === "players") return direction * ((a.playerCount ?? 0) - (b.playerCount ?? 0));
    return direction * String(a[sortKey]).localeCompare(String(b[sortKey]), undefined, { sensitivity: "base" });
  });
  const comparedServers = [...compareSet].map((name) => servers.find((server) => server.name === name)).filter((server): server is GameServer => Boolean(server));

  async function doAction(name: string, action: string) {
    setActionLoading((prev) => ({ ...prev, [name]: action }));
    try {
      if (action === "delete") {
        const res = await fetch(`/api/game-hub/servers/${name}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        toast.success(`${name} deleted`);
      } else {
        const res = await fetch(`/api/game-hub/servers/${name}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) throw new Error(`${action} failed`);
        toast.success(action === "sync-to-git" ? `${name} synced to git` : `${name} ${action} successful`);
      }
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }

  async function cloneServer(source: string) {
    const newName = prompt("Clone server as", `${source}-copy`);
    if (!newName) return;
    try {
      const res = await fetch("/api/game-hub/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clone", source, newName }),
      });
      if (!res.ok) throw new Error("Clone failed");
      toast.success("Clone started");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function doBulkAction(action: "start" | "stop" | "restart") {
    if (selected.size === 0) return;
    try {
      const res = await fetch("/api/game-hub/servers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, names: [...selected] }),
      });
      if (!res.ok) throw new Error(`${action} failed`);
      toast.success(`${action} requested for ${selected.size} server${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  function toggleSelected(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleCompare(name: string) {
    setCompareSet((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
        return next;
      }
      if (next.size >= 3) {
        toast.info("You can compare up to 3 servers at once");
        return prev;
      }
      next.add(name);
      return next;
    });
  }

  function setSort(nextKey: ServerSortKey) {
    if (sortKey === nextKey) {
      setSortDir((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(nextKey);
    setSortDir(["health", "cpu", "players", "started"].includes(nextKey) ? "desc" : "asc");
  }

  function toggleFavorite(name: string) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function resetFilters() {
    setSearch("");
    setDebouncedSearch("");
    setFilterType("");
    setFilterStatus("all");
    setFilterTag("");
    setFilterGroup("");
  }

  return (
    <div className="space-y-6">
      <AnimatePresence>
        {showPVCCleanup && <PVCCleanupModal onClose={() => setShowPVCCleanup(false)} />}
      </AnimatePresence>

      <PageHeader
        title="Game Hub"
        subtitle="Deploy and manage game servers on Kubernetes"
        icon={Gamepad2}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setShowPVCCleanup(true)} className="flex items-center gap-2 px-3 py-2 bg-[#252525] hover:bg-[#2a2a2a] border border-[#2a2a2a] text-[#9e9e9e] hover:text-[#f2f2f2] rounded-lg text-sm font-medium transition-colors">
              <HardDrive className="w-4 h-4" />
              <span className="hidden sm:inline">Cleanup PVCs</span>
            </button>
            <button
              onClick={() => {
                setCompareMode((prev) => {
                  if (prev) setCompareSet(new Set());
                  return !prev;
                });
              }}
              className={cn("flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border", compareMode ? "bg-[#0078D4]/15 border-[#0078D4]/30 text-[#4db3ff]" : "bg-[#252525] hover:bg-[#2a2a2a] border-[#2a2a2a] text-[#9e9e9e] hover:text-[#f2f2f2]")}
            >
              <BarChart2 className="w-4 h-4" />
              <span className="hidden sm:inline">{compareMode ? "Comparing" : "Compare"}</span>
            </button>
            <Link href="/game-hub/new" className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" />
              New Server
            </Link>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:min-w-[220px] sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search servers..." className="w-full bg-[#111] border border-[#2a2a2a] rounded-lg pl-8 pr-3 py-1.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50" />
        </div>
        {["all", "running", "starting", "stopped"].map((status) => (
          <button key={status} onClick={() => setFilterStatus(status)} className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors border", filterStatus === status ? "bg-[#0078D4]/20 border-[#0078D4]/40 text-[#0078D4]" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#999]")}>{status}</button>
        ))}
        {uniqueGameTypes.length > 1 && (
          <select value={filterType} onChange={(event) => setFilterType(event.target.value)} className="bg-[#111] border border-[#2a2a2a] rounded-lg px-2 py-1.5 text-xs text-[#666] focus:outline-none focus:border-[#0078D4]/50">
            <option value="">All types</option>
            {uniqueGameTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        )}
        {allGroups.length > 0 && (
          <select value={filterGroup} onChange={(event) => setFilterGroup(event.target.value)} className="bg-[#111] border border-[#2a2a2a] rounded-lg px-2 py-1.5 text-xs text-[#666] focus:outline-none focus:border-[#0078D4]/50">
            <option value="">All groups</option>
            {allGroups.map((group) => <option key={group} value={group}>{group}</option>)}
          </select>
        )}
        <select value={sortKey} onChange={(event) => setSort(event.target.value as ServerSortKey)} className="bg-[#111] border border-[#2a2a2a] rounded-lg px-2 py-1.5 text-xs text-[#666] focus:outline-none focus:border-[#0078D4]/50">
          <option value="health">Sort by health</option>
          <option value="name">Sort by name</option>
          <option value="status">Sort by status</option>
          <option value="cpu">Sort by CPU usage</option>
          <option value="players">Sort by players</option>
          <option value="started">Sort by last started</option>
        </select>
        <div className="flex items-center rounded-lg border border-[#2a2a2a] bg-[#111] p-1">
          <button onClick={() => setViewMode("detailed")} className={cn("rounded px-2 py-1 text-xs transition-colors", viewMode === "detailed" ? "bg-[#0078D4]/15 text-[#4db3ff]" : "text-[#666]")} title="Detailed cards"><LayoutGrid className="w-3.5 h-3.5" /></button>
          <button onClick={() => setViewMode("compact")} className={cn("rounded px-2 py-1 text-xs transition-colors", viewMode === "compact" ? "bg-[#0078D4]/15 text-[#4db3ff]" : "text-[#666]")} title="Compact list"><Rows3 className="w-3.5 h-3.5" /></button>
        </div>
        {(search || filterType || filterTag || filterGroup || filterStatus !== "all") && (
          <button onClick={resetFilters} className="px-3 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#111] text-xs text-[#888] hover:text-white hover:border-[#3a3a3a]">Reset</button>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setFilterTag("")} className={cn("px-2.5 py-1 rounded-full border text-[11px] transition-colors", !filterTag ? "border-[#0078D4]/30 bg-[#0078D4]/15 text-[#4db3ff]" : "border-[#2a2a2a] bg-[#111] text-[#777] hover:text-[#ccc]")}>All tags</button>
          {allTags.map((tag) => (
            <button key={tag} onClick={() => setFilterTag((prev) => prev === tag ? "" : tag)} className={cn("px-2.5 py-1 rounded-full border text-[11px] transition-colors", filterTag === tag ? "border-[#0078D4]/30 bg-[#0078D4]/15 text-[#4db3ff]" : "border-[#2a2a2a] bg-[#111] text-[#777] hover:text-[#ccc]")}>#{tag}</button>
          ))}
          {allGroups.map((group) => (
            <button key={`group-${group}`} onClick={() => setFilterGroup((prev) => prev === group ? "" : group)} className={cn("px-2.5 py-1 rounded-full border text-[11px] transition-colors", filterGroup === group ? "border-green-500/30 bg-green-500/15 text-green-300" : "border-[#2a2a2a] bg-[#111] text-[#777] hover:text-[#ccc]")}>@{group}</button>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-[#0078D4]/30 bg-[#0b1a2a] px-4 py-3">
          <span className="text-sm text-[#d4e7ff]">{selected.size} selected</span>
          <button onClick={() => doBulkAction("start")} className="px-3 py-1.5 rounded-lg bg-green-500/20 text-green-300 text-xs">Start All</button>
          <button onClick={() => doBulkAction("stop")} className="px-3 py-1.5 rounded-lg bg-[#252525] text-[#d4d4d4] text-xs">Stop All</button>
          <button onClick={() => doBulkAction("restart")} className="px-3 py-1.5 rounded-lg bg-[#252525] text-[#d4d4d4] text-xs">Restart All</button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-[#0078D4]">Deselect</button>
        </div>
      )}

      {isLoading && <div className="flex items-center justify-center h-40"><Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" /></div>}

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium">Failed to load servers</p>
            <p className="text-xs text-red-400 mt-0.5">Is the game-hub namespace set up? <Link href="/game-hub/setup" className="underline">Run setup</Link></p>
          </div>
        </div>
      )}

      {!isLoading && !error && servers.length === 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-64 rounded-xl border border-dashed border-[#2a2a2a] gap-4">
          <div className="text-5xl">🎮</div>
          <div className="text-center">
            <p className="text-[#f2f2f2] font-medium">No game servers yet</p>
            <p className="text-[#666] text-sm mt-1">Deploy your first server to get started</p>
          </div>
          <Link href="/game-hub/new" className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" />
            Deploy Server
          </Link>
        </motion.div>
      )}

      {!isLoading && !error && servers.length > 0 && filteredServers.length === 0 && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-6 text-center">
          <p className="text-sm text-[#f2f2f2] font-medium">No servers match the current filters</p>
          <p className="text-xs text-[#666] mt-1">Try clearing filters, changing the sort order, or searching for a different game.</p>
        </div>
      )}

      <div className={cn("grid gap-4", viewMode === "compact" ? "grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-3")}>
        <AnimatePresence>
          {filteredServers.map((server, index) => {
            const health = healthBadge(server);
            const cardIcon = server.icon ?? server.gameType[0]?.toUpperCase() ?? "🎮";
            const stoppedStyle = server.status === "stopped" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : (STATUS_COLORS[server.status] ?? STATUS_COLORS.stopped);
            return (
              <motion.div
                key={server.name}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: index * 0.05 }}
                className={cn("rounded-xl border bg-[#1a1a1a] flex flex-col transition-colors", viewMode === "compact" ? "p-4 gap-3" : "p-5 gap-4", compareMode ? "cursor-pointer" : "cursor-pointer hover:border-[#3a3a3a]", compareSet.has(server.name) ? "border-[#0078D4] ring-1 ring-[#0078D4]/40" : "border-[#2a2a2a]")}
                onClick={() => compareMode ? toggleCompare(server.name) : router.push(`/game-hub/${server.name}`)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex flex-col items-center gap-2 pt-1">
                      <button onClick={(event) => { event.stopPropagation(); toggleFavorite(server.name); }} className="text-[#666] hover:text-yellow-300 transition-colors" title={favorites.has(server.name) ? "Remove favorite" : "Favorite server"}>
                        <Star className={cn("w-4 h-4", favorites.has(server.name) && "fill-yellow-300 text-yellow-300")} />
                      </button>
                      <button onClick={(event) => { event.stopPropagation(); toggleSelected(server.name); }}>
                        {selected.has(server.name) ? <CheckSquare className="w-4 h-4 text-[#0078D4]" /> : <SquareIcon className="w-4 h-4 text-[#666]" />}
                      </button>
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-[#252525] flex items-center justify-center text-xl flex-shrink-0">{cardIcon}</div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm text-[#f2f2f2] truncate">{server.name}</p>
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 border capitalize", stoppedStyle)}>{server.status}</span>
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 border", health.className)}>{server.status === "stopped" ? "Stopped" : `Health ${health.label}`}</span>
                        {server.status === "stopped" && <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-200">Stopped</span>}
                        {server.inGit ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-300" title="Manifest committed to git — survives cluster rebuild">IaC ✓</span>
                        ) : (
                          <>
                            <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#444] bg-[#252525] text-[#b3b3b3]" title="No manifest in git — will be lost on cluster rebuild">Not in Git</span>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                void doAction(server.name, "sync-to-git");
                              }}
                              disabled={actionLoading[server.name] === "sync-to-git"}
                              className="inline-flex items-center gap-1 rounded-full border border-[#2f6fa8] bg-[#0078D4]/10 px-2 py-0.5 text-[10px] font-medium text-[#7cc4ff] transition-colors hover:bg-[#0078D4]/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {actionLoading[server.name] === "sync-to-git" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                              Sync
                            </button>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-[#666] capitalize mt-0.5">{server.gameType.replace(/-/g, " ")}</p>
                      {server.description && <p className="text-[11px] text-[#777] mt-1 line-clamp-2">{server.description}</p>}
                      {((server.tags ?? []).length > 0 || (server.groups ?? []).length > 0 || server.imageVersion) && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {(server.tags ?? []).map((tag) => <span key={tag} className="px-1.5 py-0.5 rounded-full bg-[#111] border border-[#2a2a2a] text-[10px] text-[#9e9e9e]">#{tag}</span>)}
                          {(server.groups ?? []).map((group) => <span key={group} className="px-1.5 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-[10px] text-green-300">@{group}</span>)}
                          {server.imageVersion && <span className={cn("px-1.5 py-0.5 rounded-full border text-[10px]", server.imagePinned ? "bg-[#111] border-[#2a2a2a] text-[#9e9e9e]" : "bg-yellow-500/10 border-yellow-500/20 text-yellow-200")}>{server.imagePinned ? `v${server.imageVersion}` : `latest (${server.imageVersion})`}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className={cn("grid gap-2 text-xs text-[#666]", viewMode === "compact" ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-1 sm:grid-cols-2")}>
                  <div>Port: <span className="text-[#9e9e9e]">{server.nodePort || server.port || "—"}</span></div>
                  <div>Memory: <span className="text-[#9e9e9e]">{server.memory || "—"}</span></div>
                  <div>CPU: <span className="text-[#9e9e9e]">{server.cpu || "—"}</span></div>
                  <div>Players: <span className="text-[#9e9e9e]">{server.playerCount ?? 0}</span></div>
                  <div>Last restart: <span className="text-[#9e9e9e]">{server.podStartTime ? timeAgo(server.podStartTime) : "—"}</span></div>
                  <div>Replicas: <span className="text-[#9e9e9e]">{replicaSummary(server)}</span></div>
                </div>
                <div className="flex items-center gap-2 flex-wrap" onClick={(event) => event.stopPropagation()}>
                  {server.status === "stopped" ? (
                    <button onClick={() => doAction(server.name, "start")} disabled={!!actionLoading[server.name]} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                      {actionLoading[server.name] === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Start
                    </button>
                  ) : (
                    <>
                      <button onClick={() => doAction(server.name, "stop")} disabled={!!actionLoading[server.name]} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                        {actionLoading[server.name] === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />} Stop
                      </button>
                      <button onClick={() => doAction(server.name, "restart")} disabled={!!actionLoading[server.name]} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                        {actionLoading[server.name] === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Restart
                      </button>
                    </>
                  )}
                  <button onClick={() => cloneServer(server.name)} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors">Clone</button>
                  <Link href={`/game-hub/${server.name}`} className="flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(0,120,212,0.15)] hover:bg-[rgba(0,120,212,0.25)] text-[#0078D4] rounded-lg text-xs font-medium transition-colors">
                    <Terminal className="w-3.5 h-3.5" /> Console
                  </Link>
                  <button onClick={() => { if (confirm(`Delete ${server.name}? This will remove the server and its data.`)) doAction(server.name, "delete"); }} disabled={!!actionLoading[server.name]} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                    {actionLoading[server.name] === "delete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {compareMode && comparedServers.length >= 2 && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
            <BarChart2 className="w-4 h-4 text-[#4db3ff]" />
            <div>
              <p className="text-sm font-medium text-[#f2f2f2]">Server Comparison</p>
              <p className="text-xs text-[#666]">Compare up to three servers side by side.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] sm:min-w-[640px] text-sm">
              <thead className="bg-[#0d0d0d]">
                <tr>
                  <th className="text-left px-4 py-3 text-xs uppercase tracking-wide text-[#666]">Metric</th>
                  {comparedServers.map((server) => (
                    <th key={server.name} className="text-left px-4 py-3 text-xs uppercase tracking-wide text-[#888]">{server.icon ?? server.gameType[0]?.toUpperCase() ?? "🎮"} {server.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Status", render: (server: GameServer) => server.status },
                  { label: "Game type", render: (server: GameServer) => server.gameType },
                  { label: "Replicas", render: replicaSummary },
                  { label: "CPU usage", render: (server: GameServer) => formatUsage(server.cpuUsage, server.cpuLimit, "cpu") },
                  { label: "Memory usage", render: (server: GameServer) => formatUsage(server.memoryUsage, server.memoryLimit, "memory") },
                  { label: "Restarts", render: (server: GameServer) => String(server.restartCount ?? 0) },
                  { label: "Uptime", render: (server: GameServer) => formatUptime(server.podStartTime, now) },
                ].map((row) => (
                  <tr key={row.label} className="border-t border-[#1e1e1e]">
                    <td className="px-4 py-3 text-[#666] text-xs uppercase tracking-wide">{row.label}</td>
                    {comparedServers.map((server) => (
                      <td key={`${row.label}-${server.name}`} className="px-4 py-3 text-[#d4d4d4]">{row.render(server)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <button onClick={() => setShowRoadmap((prev) => !prev)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left border-b border-[#1e1e1e]">
          <div className="flex items-start gap-3">
            <BookOpen className="w-4 h-4 text-[#4db3ff] mt-0.5" />
            <div>
              <p className="text-sm font-medium text-[#f2f2f2]">Feature Roadmap</p>
              <p className="text-xs text-[#666] mt-0.5">100 ideas across 10 categories, with shipped game hub features highlighted.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[#666]">
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#2a2a2a] bg-[#0d0d0d]">{FEATURE_ROADMAP.reduce((sum, category) => sum + category.items.length, 0)} items</span>
            {showRoadmap ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </button>
        {showRoadmap && (
          <div className="p-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {FEATURE_ROADMAP.map((category) => (
              <div key={category.category} className="rounded-xl border border-[#1e1e1e] bg-[#0b0b0b] p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-[#f2f2f2] uppercase tracking-wide">{category.category}</p>
                  <span className="text-[10px] text-[#444]">{category.items.length}/10</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {category.items.map((feature) => (
                    <div key={feature.name} className="rounded-lg border border-[#1d1d1d] bg-[#111] px-2.5 py-2">
                      <div className="flex items-start gap-2">
                        <span className={cn("mt-0.5 text-[11px] leading-none", feature.status === "Shipped" ? "text-green-400" : "text-[#333]")}>{feature.status === "Shipped" ? "✓" : "•"}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-[#d4d4d4] leading-snug">{feature.name}</p>
                          <span className={cn("inline-flex mt-1 text-[9px] px-1.5 py-0.5 rounded-full border", ROADMAP_STATUS_STYLES[feature.status])}>{feature.status}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
