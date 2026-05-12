"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Gamepad2, Play, Square, RotateCcw, Trash2, Terminal, Loader2, AlertTriangle, HardDrive, X, CheckSquare, Square as SquareIcon, Search, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
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
}

interface UnusedPVC {
  namespace: string;
  name: string;
  status: string;
  storageClass: string;
  capacity: string;
  createdAt: string | null;
}

const GAME_ICONS: Record<string, string> = {
  minecraft: "⛏",
  terraria: "🌍",
  valheim: "🪓",
};

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
      { name: "Server clone", status: "Planned" },
      { name: "Templates library", status: "Planned" },
      { name: "Bulk start/stop", status: "Planned" },
      { name: "Scheduled on/off", status: "Coming Soon" },
      { name: "Maintenance mode", status: "Coming Soon" },
    ],
  },
  {
    category: "Monitoring",
    items: [
      { name: "Status indicator", status: "Shipped" },
      { name: "Uptime counter", status: "Shipped" },
      { name: "CPU/RAM graphs", status: "Planned" },
      { name: "Network traffic", status: "Coming Soon" },
      { name: "Player count timeline", status: "Planned" },
      { name: "Minecraft TPS", status: "Coming Soon" },
      { name: "Disk usage chart", status: "Planned" },
      { name: "Event timeline", status: "Shipped" },
      { name: "Alert thresholds", status: "Coming Soon" },
      { name: "Performance score", status: "Coming Soon" },
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
      { name: "Player kick/ban", status: "Planned" },
      { name: "Whitelist editor", status: "Planned" },
      { name: "Quick commands panel", status: "Shipped" },
      { name: "Console search", status: "Coming Soon" },
      { name: "Console export", status: "Shipped" },
    ],
  },
  {
    category: "File Management",
    items: [
      { name: "File browser", status: "Shipped" },
      { name: "Monaco editor", status: "Shipped" },
      { name: "File delete", status: "Shipped" },
      { name: "File upload", status: "Planned" },
      { name: "File download", status: "Coming Soon" },
      { name: "Directory create", status: "Coming Soon" },
      { name: "File rename", status: "Coming Soon" },
      { name: "Permissions viewer", status: "Coming Soon" },
      { name: "Binary file viewer", status: "Coming Soon" },
      { name: "File diff", status: "Coming Soon" },
    ],
  },
  {
    category: "Backup & Recovery",
    items: [
      { name: "Manual world backup", status: "Planned" },
      { name: "Scheduled backups", status: "Coming Soon" },
      { name: "Backup retention", status: "Coming Soon" },
      { name: "Restore from backup", status: "Coming Soon" },
      { name: "Cross-server transfer", status: "Coming Soon" },
      { name: "Backup size tracking", status: "Coming Soon" },
      { name: "Backup verification", status: "Coming Soon" },
      { name: "TrueNAS target", status: "Planned" },
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
      { name: "Server ping", status: "Coming Soon" },
    ],
  },
  {
    category: "Player Management",
    items: [
      { name: "Online player list", status: "Planned" },
      { name: "Whitelist editor", status: "Planned" },
      { name: "Op management", status: "Planned" },
      { name: "Ban list", status: "Planned" },
      { name: "Player stats", status: "Coming Soon" },
      { name: "Discord webhooks", status: "Planned" },
      { name: "GeoIP map", status: "Coming Soon" },
      { name: "Chat viewer", status: "Coming Soon" },
      { name: "Player history", status: "Coming Soon" },
      { name: "Player groups", status: "Coming Soon" },
    ],
  },
  {
    category: "Mods & Plugins",
    items: [
      { name: "Mod list viewer", status: "Planned" },
      { name: "Plugin list", status: "Planned" },
      { name: "Modrinth install", status: "Coming Soon" },
      { name: "Mod updater", status: "Coming Soon" },
      { name: "Mod conflicts", status: "Coming Soon" },
      { name: "Plugin config editor", status: "Coming Soon" },
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
      { name: "TrueNAS backend", status: "Planned" },
      { name: "Synology backend", status: "Planned" },
      { name: "ZFS snapshots", status: "Coming Soon" },
      { name: "PVC expansion", status: "Planned" },
      { name: "Data migration", status: "Coming Soon" },
      { name: "IO benchmark", status: "Coming Soon" },
      { name: "Storage analytics", status: "Coming Soon" },
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
      { name: "Audit log", status: "Planned" },
      { name: "Command ACL", status: "Planned" },
      { name: "File access control", status: "Coming Soon" },
      { name: "Two-factor auth", status: "Coming Soon" },
      { name: "API tokens", status: "Coming Soon" },
      { name: "Session management", status: "Coming Soon" },
      { name: "Security alerts", status: "Coming Soon" },
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
      const res = await fetch("/api/storage/pvc-cleanup");
      if (!res.ok) throw new Error("Failed to fetch unused PVCs");
      const d = await res.json() as { unused: UnusedPVC[] };
      // auto-check all on first load
      setChecked(new Set(d.unused.map(p => `${p.namespace}/${p.name}`)));
      return d;
    },
    staleTime: 0,
  });

  const unused = data?.unused ?? [];

  function toggleAll() {
    if (checked.size === unused.length) setChecked(new Set());
    else setChecked(new Set(unused.map(p => `${p.namespace}/${p.name}`)));
  }

  function toggle(key: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function doCleanup() {
    const toDelete = unused.filter(p => checked.has(`${p.namespace}/${p.name}`));
    if (toDelete.length === 0) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/storage/pvc-cleanup", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pvcs: toDelete.map(p => ({ namespace: p.namespace, name: p.name })) }),
      });
      const result = await res.json() as { deleted: number; failed: number };
      if (result.failed > 0) toast.error(`${result.failed} PVC(s) failed to delete`);
      else toast.success(`${result.deleted} PVC(s) deleted`);
      onClose();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
      >
        {/* Header */}
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

        {/* Body */}
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
              {unused.map(pvc => {
                const key = `${pvc.namespace}/${pvc.name}`;
                const isChecked = checked.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggle(key)}
                    className={cn(
                      "w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors",
                      isChecked
                        ? "bg-red-500/10 border-red-500/30 hover:bg-red-500/15"
                        : "bg-[#252525] border-[#2a2a2a] hover:bg-[#2a2a2a]"
                    )}
                  >
                    <div className={cn("mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center",
                      isChecked ? "bg-red-500 border-red-500" : "border-[#444]")}>
                      {isChecked && <span className="text-white text-[10px] font-bold">✓</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-[#f2f2f2] truncate">{pvc.name}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0",
                          pvc.status === "Released" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" :
                          pvc.status === "Lost" ? "bg-red-500/20 text-red-300 border-red-500/30" :
                          "bg-[#333] text-[#999] border-[#444]")}>{pvc.status}</span>
                      </div>
                      <p className="text-[11px] text-[#666] mt-0.5">{pvc.namespace} · {pvc.storageClass || "default"} · {pvc.capacity || "unknown size"}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {!isLoading && unused.length > 0 && (
          <div className="flex items-center justify-between gap-3 p-5 border-t border-[#2a2a2a]">
            <p className="text-xs text-[#666]">{checked.size} of {unused.length} selected</p>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] text-sm font-medium transition-colors">
                Cancel
              </button>
              <button
                onClick={doCleanup}
                disabled={checked.size === 0 || deleting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete {checked.size > 0 ? `${checked.size} PVC${checked.size !== 1 ? "s" : ""}` : ""}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

export default function GameHubPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showPVCCleanup, setShowPVCCleanup] = useState(false);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showRoadmap, setShowRoadmap] = useState(false);

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
  const uniqueGameTypes = [...new Set(servers.map(s => s.gameType))].sort();
  const filteredServers = servers.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterStatus !== "all" && s.status !== filterStatus) return false;
    if (filterType && s.gameType !== filterType) return false;
    return true;
  });

  async function doAction(name: string, action: string) {
    setActionLoading(prev => ({ ...prev, [name]: action }));
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
        toast.success(`${name} ${action} successful`);
      }
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[name]; return n; });
    }
  }

  void router;

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
            <button
              onClick={() => setShowPVCCleanup(true)}
              className="flex items-center gap-2 px-3 py-2 bg-[#252525] hover:bg-[#2a2a2a] border border-[#2a2a2a] text-[#9e9e9e] hover:text-[#f2f2f2] rounded-lg text-sm font-medium transition-colors"
            >
              <HardDrive className="w-4 h-4" />
              <span className="hidden sm:inline">Cleanup PVCs</span>
            </button>
            <Link
              href="/game-hub/new"
              className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Server
            </Link>
          </div>
        }
      />

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search servers..."
            className="w-full bg-[#111] border border-[#2a2a2a] rounded-lg pl-8 pr-3 py-1.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50" />
        </div>
        {["all", "running", "starting", "stopped"].map(s => (
          <button key={s} onClick={() => setFilterStatus(s)}
            className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors border",
              filterStatus === s ? "bg-[#0078D4]/20 border-[#0078D4]/40 text-[#0078D4]" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#999]")}>
            {s}
          </button>
        ))}
        {uniqueGameTypes.length > 1 && (
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="bg-[#111] border border-[#2a2a2a] rounded-lg px-2 py-1.5 text-xs text-[#666] focus:outline-none focus:border-[#0078D4]/50">
            <option value="">All types</option>
            {uniqueGameTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
        </div>
      )}

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
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center h-64 rounded-xl border border-dashed border-[#2a2a2a] gap-4"
        >
          <div className="text-5xl">🎮</div>
          <div className="text-center">
            <p className="text-[#f2f2f2] font-medium">No game servers yet</p>
            <p className="text-[#666] text-sm mt-1">Deploy your first server to get started</p>
          </div>
          <Link
            href="/game-hub/new"
            className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Deploy Server
          </Link>
        </motion.div>
      )}

      {!isLoading && !error && servers.length > 0 && filteredServers.length === 0 && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-6 text-center">
          <p className="text-sm text-[#f2f2f2] font-medium">No servers match the current filters</p>
          <p className="text-xs text-[#666] mt-1">Try a different search, status, or game type.</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence>
          {filteredServers.map((server, i) => (
            <motion.div
              key={server.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: i * 0.05 }}
              className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-5 flex flex-col gap-4 cursor-pointer hover:border-[#3a3a3a] transition-colors"
              onClick={() => window.location.href = `/game-hub/${server.name}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-[#252525] flex items-center justify-center text-xl">
                    {GAME_ICONS[server.gameType] ?? "🎮"}
                  </div>
                  <div>
                    <p className="font-medium text-sm text-[#f2f2f2]">{server.name}</p>
                    <p className="text-xs text-[#666] capitalize">{server.gameType}</p>
                  </div>
                </div>
                <span className={cn("text-xs font-medium rounded-full px-2 py-0.5 border capitalize", STATUS_COLORS[server.status] ?? STATUS_COLORS.stopped)}>
                  {server.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-[#666]">
                <div>Port: <span className="text-[#9e9e9e]">{server.nodePort || server.port || "—"}</span></div>
                <div>Memory: <span className="text-[#9e9e9e]">{server.memory || "—"}</span></div>
              </div>

              <div className="flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                {server.status === "stopped" ? (
                  <button
                    onClick={() => doAction(server.name, "start")}
                    disabled={!!actionLoading[server.name]}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    {actionLoading[server.name] === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    Start
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => doAction(server.name, "stop")}
                      disabled={!!actionLoading[server.name]}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {actionLoading[server.name] === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                      Stop
                    </button>
                    <button
                      onClick={() => doAction(server.name, "restart")}
                      disabled={!!actionLoading[server.name]}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {actionLoading[server.name] === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      Restart
                    </button>
                  </>
                )}
                <Link
                  href={`/game-hub/${server.name}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(0,120,212,0.15)] hover:bg-[rgba(0,120,212,0.25)] text-[#0078D4] rounded-lg text-xs font-medium transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  Console
                </Link>
                <button
                  onClick={() => { if (confirm(`Delete ${server.name}? This will remove the server and its data.`)) doAction(server.name, "delete"); }}
                  disabled={!!actionLoading[server.name]}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {actionLoading[server.name] === "delete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <button
          onClick={() => setShowRoadmap(v => !v)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left border-b border-[#1e1e1e]"
        >
          <div>
            <p className="text-sm font-medium text-[#f2f2f2]">Feature Roadmap</p>
            <p className="text-xs text-[#666] mt-0.5">100 ideas across 10 categories, with shipped game hub features highlighted.</p>
          </div>
          <div className="flex items-center gap-2 text-[#666]">
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#2a2a2a] bg-[#0d0d0d]">
              {FEATURE_ROADMAP.reduce((sum, category) => sum + category.items.length, 0)} items
            </span>
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
                        <span className={cn(
                          "mt-0.5 text-[11px] leading-none",
                          feature.status === "Shipped" ? "text-green-400" : "text-[#333]"
                        )}>
                          {feature.status === "Shipped" ? "✓" : "•"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-[#d4d4d4] leading-snug">{feature.name}</p>
                          <span className={cn(
                            "inline-flex mt-1 text-[9px] px-1.5 py-0.5 rounded-full border",
                            ROADMAP_STATUS_STYLES[feature.status]
                          )}>
                            {feature.status}
                          </span>
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
