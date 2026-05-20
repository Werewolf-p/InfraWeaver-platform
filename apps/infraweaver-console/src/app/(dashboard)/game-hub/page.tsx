"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Lock, Gamepad2, Play, Square, RotateCcw, Trash2, Terminal, Loader2, AlertTriangle, HardDrive, CheckSquare, Square as SquareIcon, Search, ChevronDown, ChevronUp, BarChart2, BookOpen, Star, LayoutGrid, Rows3, MoreVertical } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { useRBAC } from "@/hooks/use-rbac";
import { toast } from "@/lib/notify";
import Link from "next/link";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { HorizontalScrollHint } from "@/components/ui/horizontal-scroll-hint";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";

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
  permissions?: {
    canRead: boolean;
    canPlayers: boolean;
    canConsole: boolean;
    canFiles: boolean;
    canAdmin: boolean;
    canStart: boolean;
    canStop: boolean;
  };
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
  stopped: "bg-[#333] text-gray-500 dark:text-[#999] border-gray-200 dark:border-[#444]",
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
      { name: "Scheduled on/off", status: "Shipped" },
      { name: "Maintenance mode", status: "Shipped" },
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
      { name: "Alert thresholds", status: "Shipped" },
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
      { name: "Inline text editor", status: "Shipped" },
      { name: "File delete", status: "Shipped" },
      { name: "File upload", status: "Shipped" },
      { name: "File download", status: "Shipped" },
      { name: "Directory create", status: "Shipped" },
      { name: "File rename", status: "Shipped" },
      { name: "Permissions viewer", status: "Shipped" },
      { name: "Binary file viewer", status: "Shipped" },
      { name: "File diff", status: "Shipped" },
    ],
  },
  {
    category: "Backup & Recovery",
    items: [
      { name: "Manual world backup", status: "Shipped" },
      { name: "Scheduled backups", status: "Shipped" },
      { name: "Backup retention", status: "Shipped" },
      { name: "Restore from backup", status: "Shipped" },
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
  "Coming Soon": "bg-gray-50 dark:bg-[#252525] text-gray-500 dark:text-[#999] border-gray-200 dark:border-[#333]",
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
    <ResponsiveSheet
      open
      onClose={onClose}
      size="lg"
      title="PVC Cleanup"
      description="Review unused volumes, select what to remove, and swipe down when you are done."
      footer={!isLoading && unused.length > 0 ? (
        <div className="space-y-3 sm:flex sm:items-center sm:justify-between sm:gap-4 sm:space-y-0">
          <p className="text-sm text-gray-500 dark:text-[#888]">{checked.size} of {unused.length} selected</p>
          <div className="grid grid-cols-1 gap-3 sm:flex sm:gap-2">
            <button onClick={onClose} className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">Cancel</button>
            <button onClick={doCleanup} disabled={checked.size === 0 || deleting} className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-red-500/20 px-4 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-50">
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete {checked.size > 0 ? `${checked.size} PVC${checked.size !== 1 ? "s" : ""}` : "selected PVCs"}
            </button>
          </div>
        </div>
      ) : undefined}
    >
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-24 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] animate-pulse" />
          ))}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <p className="font-medium text-red-100">PVC scan failed</p>
            <p className="mt-1">{String(error)}</p>
          </div>
        </div>
      )}
      {!isLoading && !error && unused.length === 0 && (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] p-6 text-center">
          <div className="text-4xl">✅</div>
          <p className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">No unused PVCs found</p>
          <p className="text-sm text-gray-500 dark:text-[#888]">All PersistentVolumeClaims are currently bound and in use.</p>
        </div>
      )}
      {!isLoading && unused.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-semibold text-gray-900 dark:text-white">{unused.length} unused PVC{unused.length !== 1 ? "s" : ""}</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-[#888]">Select the volumes you want to remove. Destructive actions stay in the bottom footer for thumb reach.</p>
            </div>
            <button onClick={toggleAll} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 text-sm font-medium text-[#9ecfff] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">
              {checked.size === unused.length ? <SquareIcon className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
              {checked.size === unused.length ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="space-y-3">
            {unused.map((pvc) => {
              const key = `${pvc.namespace}/${pvc.name}`;
              const isChecked = checked.has(key);
              return (
                <button key={key} onClick={() => toggle(key)} className={cn("w-full rounded-2xl border p-4 text-left transition-colors", isChecked ? "border-red-500/30 bg-red-500/10 hover:bg-red-500/15" : "border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] hover:border-[#3a3a3a]")}>
                  <div className="flex items-start gap-3">
                    <div className={cn("mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border", isChecked ? "border-red-500 bg-red-500" : "border-[#555]")}>{isChecked ? <span className="text-sm font-bold text-gray-900 dark:text-white">✓</span> : null}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{pvc.name}</span>
                        <span className={cn("rounded-full border px-3 py-1 text-sm font-medium", pvc.status === "Released" ? "border-yellow-500/30 bg-yellow-500/20 text-yellow-200" : pvc.status === "Lost" ? "border-red-500/30 bg-red-500/20 text-red-200" : "border-gray-200 dark:border-[#444] bg-gray-50 dark:bg-[#252525] text-gray-600 dark:text-[#b3b3b3]")}>{pvc.status}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-gray-600 dark:text-[#b3b3b3] sm:grid-cols-3">
                        <div>
                          <p className="text-gray-500 dark:text-[#777]">Namespace</p>
                          <p className="mt-1 text-gray-900 dark:text-white">{pvc.namespace}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-[#777]">Storage class</p>
                          <p className="mt-1 text-gray-900 dark:text-white">{pvc.storageClass || "default"}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-[#777]">Capacity</p>
                          <p className="mt-1 text-gray-900 dark:text-white">{pvc.capacity || "unknown size"}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ResponsiveSheet>
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
  if (server.status === "stopped") return { label: "Stopped", score, className: "bg-[#333] text-[#bbb] border-gray-200 dark:border-[#444]" };
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

function ServerActionSheet({
  server,
  open,
  onClose,
  actionLoading,
  onAction,
  onClone,
  onToggleFavorite,
  onToggleSelected,
  onToggleCompare,
  isFavorite,
  isSelected,
  compareSelected,
  now,
}: {
  server: GameServer | null;
  open: boolean;
  onClose: () => void;
  actionLoading?: string;
  onAction: (action: string) => Promise<void>;
  onClone: () => Promise<void>;
  onToggleFavorite: () => void;
  onToggleSelected: () => void;
  onToggleCompare: () => void;
  isFavorite: boolean;
  isSelected: boolean;
  compareSelected: boolean;
  now: number;
}) {
  if (!server) return null;

  const metrics = [
    { label: "Players", value: String(server.playerCount ?? 0) },
    { label: "CPU", value: formatUsage(server.cpuUsage, server.cpuLimit, "cpu") },
    { label: "Memory", value: formatUsage(server.memoryUsage, server.memoryLimit, "memory") },
    { label: "Uptime", value: formatUptime(server.podStartTime, now) },
  ];

  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      title={<span>{server.icon ?? server.gameType[0]?.toUpperCase() ?? "🎮"} {server.name}</span>}
      description="Thumb-friendly actions, swipe-to-dismiss, and live server health in one place."
      footer={
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link
            href={`/game-hub/${server.name}`}
            onClick={onClose}
            className="inline-flex min-h-[48px] items-center justify-center rounded-2xl bg-[#0078D4] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#006cbe]"
          >
            {server.permissions?.canConsole ? "Open Console" : "Open Details"}
          </Link>
          <button
            type="button"
            onClick={() => {
              onToggleSelected();
              onClose();
            }}
            className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white"
          >
            {isSelected ? "Selected for bulk actions" : "Select for bulk actions"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] p-3">
              <p className="text-sm text-gray-500 dark:text-[#888]">{metric.label}</p>
              <p className="mt-1 text-base font-semibold text-gray-900 dark:text-white">{metric.value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-3 py-1 text-sm font-medium capitalize", STATUS_COLORS[server.status] ?? STATUS_COLORS.stopped)}>{server.status}</span>
            <span className={cn("rounded-full border px-3 py-1 text-sm font-medium", healthBadge(server).className)}>
              {server.status === "stopped" ? "Stopped" : `Health ${healthBadge(server).label}`}
            </span>
            <span className={cn("rounded-full border px-3 py-1 text-sm font-medium", server.inGit ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-gray-200 dark:border-[#444] bg-gray-50 dark:bg-[#252525] text-gray-600 dark:text-[#b3b3b3]")}>{server.inGit ? "IaC tracked" : "Cluster-only"}</span>
          </div>
          <p className="mt-3 text-sm text-gray-600 dark:text-[#b3b3b3]">{server.description ?? "Use the action sheet for quick lifecycle operations without leaving the list."}</p>
        </div>

        <div className="space-y-2">
          {(server.status === "stopped" && server.permissions?.canStart) ? (
            <button type="button" onClick={() => void onAction("start")} disabled={!!actionLoading} className="flex min-h-[52px] w-full items-center justify-between rounded-2xl border border-green-500/30 bg-green-500/15 px-4 text-left text-sm font-medium text-green-200 transition-colors hover:bg-green-500/25 disabled:opacity-50">
              <span className="flex items-center gap-3"><Play className="h-4 w-4" /> Start server</span>
              {actionLoading === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            </button>
          ) : null}
          {(server.status !== "stopped" && server.permissions?.canAdmin) ? (
            <button type="button" onClick={() => void onAction("restart")} disabled={!!actionLoading} className="flex min-h-[52px] w-full items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-left text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white disabled:opacity-50">
              <span className="flex items-center gap-3"><RotateCcw className="h-4 w-4" /> Restart server</span>
              {actionLoading === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            </button>
          ) : null}
          {(server.status !== "stopped" && server.permissions?.canStop) ? (
            <button type="button" onClick={() => void onAction("stop")} disabled={!!actionLoading} className="flex min-h-[52px] w-full items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-left text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-red-500/30 hover:text-red-300 disabled:opacity-50">
              <span className="flex items-center gap-3"><Square className="h-4 w-4" /> Stop server</span>
              {actionLoading === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            </button>
          ) : null}
          {server.permissions?.canAdmin ? (
            <button type="button" onClick={() => void onClone()} className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-left text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">
              <Plus className="h-4 w-4" /> Clone server
            </button>
          ) : null}
          {!server.inGit && server.permissions?.canAdmin ? (
            <button type="button" onClick={() => void onAction("sync-to-git")} disabled={!!actionLoading} className="flex min-h-[52px] w-full items-center justify-between rounded-2xl border border-[#2f6fa8] bg-[#0078D4]/10 px-4 text-left text-sm font-medium text-[#7cc4ff] transition-colors hover:bg-[#0078D4]/20 disabled:opacity-50">
              <span>Sync manifest to Git</span>
              {actionLoading === "sync-to-git" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            </button>
          ) : null}
          <button type="button" onClick={() => { onToggleFavorite(); onClose(); }} className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-left text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">
            <Star className={cn("h-4 w-4", isFavorite && "fill-yellow-300 text-yellow-300")} />
            {isFavorite ? "Remove favorite" : "Add to favorites"}
          </button>
          <button type="button" onClick={() => { onToggleCompare(); onClose(); }} className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-left text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">
            <BarChart2 className="h-4 w-4" />
            {compareSelected ? "Remove from compare" : "Add to compare"}
          </button>
          {server.permissions?.canAdmin ? (
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete ${server.name}? This will remove the server and its data.`)) {
                  void onAction("delete");
                }
              }}
              disabled={!!actionLoading}
              className="flex min-h-[52px] w-full items-center justify-between rounded-2xl border border-red-500/25 bg-red-500/10 px-4 text-left text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
            >
              <span className="flex items-center gap-3"><Trash2 className="h-4 w-4" /> Delete server</span>
              {actionLoading === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            </button>
          ) : null}
        </div>

        <p className="text-sm text-gray-500 dark:text-[#777]">Tip: long-press any server card to open this action sheet without aiming for the menu button.</p>
      </div>
    </ResponsiveSheet>
  );
}

export default function GameHubPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useRBAC();
  const canManageGameHub = can("game-hub:admin", "/game-hub/");
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showPVCCleanup, setShowPVCCleanup] = useState(false);
  const [search, setSearch] = useState("");
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
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
  const [activeActionServerName, setActiveActionServerName] = useState<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const immediate = setTimeout(tick, 0);
    const interval = setInterval(tick, 60000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
  }, []);

  function clearLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function startLongPress(name: string) {
    if (compareMode || typeof window === "undefined") return;
    clearLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      navigator.vibrate?.(10);
      setActiveActionServerName(name);
    }, 450);
  }

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

  useEffect(() => () => clearLongPress(), []);

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ["game-hub", "servers"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/servers");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<{ servers: GameServer[]; setupRequired?: boolean; reason?: string }>;
    },
    refetchInterval: 15000,
  });

  const servers = data?.servers ?? [];
  const setupRequired = data?.setupRequired ?? false;
  const setupReason = data?.reason ?? "";
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
  const selectedServers = filteredServers.filter((server) => selected.has(server.name));
  const activeActionServer = activeActionServerName ? servers.find((server) => server.name === activeActionServerName) ?? null : null;
  const canBulkStart = selectedServers.some((server) => server.permissions?.canStart);
  const canBulkStop = selectedServers.some((server) => server.permissions?.canStop);
  const canBulkRestart = selectedServers.some((server) => server.permissions?.canAdmin);

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

  function openServerActions(name: string) {
    clearLongPress();
    setActiveActionServerName(name);
  }

  function resetFilters() {
    setSearch("");
    setDebouncedSearch("");
    setFilterType("");
    setFilterStatus("all");
    setFilterTag("");
    setFilterGroup("");
  }

  async function handleActionFromSheet(action: string) {
    if (!activeActionServer) return;
    await doAction(activeActionServer.name, action);
    setActiveActionServerName(null);
  }

  return (
    <div className="space-y-6">
      <AnimatePresence>
        {showPVCCleanup && <PVCCleanupModal onClose={() => setShowPVCCleanup(false)} />}
      </AnimatePresence>
      <ServerActionSheet
        server={activeActionServer}
        open={Boolean(activeActionServer)}
        onClose={() => setActiveActionServerName(null)}
        actionLoading={activeActionServer ? actionLoading[activeActionServer.name] : undefined}
        onAction={handleActionFromSheet}
        onClone={async () => {
          if (!activeActionServer) return;
          await cloneServer(activeActionServer.name);
          setActiveActionServerName(null);
        }}
        onToggleFavorite={() => { if (activeActionServer) toggleFavorite(activeActionServer.name); }}
        onToggleSelected={() => { if (activeActionServer) toggleSelected(activeActionServer.name); }}
        onToggleCompare={() => { if (activeActionServer) toggleCompare(activeActionServer.name); }}
        isFavorite={activeActionServer ? favorites.has(activeActionServer.name) : false}
        isSelected={activeActionServer ? selected.has(activeActionServer.name) : false}
        compareSelected={activeActionServer ? compareSet.has(activeActionServer.name) : false}
        now={now}
      />

      <PageHeader
        title="Game Hub"
        subtitle="Deploy and manage game servers on Kubernetes"
        icon={Gamepad2}
        actions={
          <div className="flex items-center gap-2">
            <RefreshCountdown intervalSeconds={15} resetKey={dataUpdatedAt} className="hidden sm:inline-flex" />
            {canManageGameHub ? (
              <button onClick={() => setShowPVCCleanup(true)} className="flex min-h-[44px] items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#252525] px-3 py-2 text-sm font-medium text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] hover:text-gray-900 dark:hover:text-[#f2f2f2]">
                <HardDrive className="w-4 h-4" />
                <span className="hidden sm:inline">Cleanup PVCs</span>
              </button>
            ) : null}
            <button
              onClick={() => {
                setCompareMode((prev) => {
                  if (prev) setCompareSet(new Set());
                  return !prev;
                });
              }}
              className={cn("flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border", compareMode ? "bg-[#0078D4]/15 border-[#0078D4]/30 text-[#4db3ff]" : "bg-gray-50 dark:bg-[#252525] hover:bg-gray-100 dark:hover:bg-[#2a2a2a] border-gray-200 dark:border-[#2a2a2a] text-gray-500 dark:text-[#9e9e9e] hover:text-gray-900 dark:hover:text-[#f2f2f2]")}
            >
              <BarChart2 className="w-4 h-4" />
              <span className="hidden sm:inline">{compareMode ? "Comparing" : "Compare"}</span>
            </button>
            {canManageGameHub ? (
              <Link href="/game-hub/new" className="hidden min-h-[44px] items-center gap-2 rounded-lg bg-[#0078D4] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#006cbe] sm:flex">
                <Plus className="w-4 h-4" />
                New Server
              </Link>
            ) : (
              <span
                title="Requires game-hub:admin permission"
                className="hidden cursor-not-allowed select-none items-center gap-2 rounded-lg bg-gray-100 dark:bg-[#252525] px-4 py-2 text-sm font-medium text-gray-400 dark:text-[#555] opacity-60 sm:flex min-h-[44px]"
              >
                <Lock className="w-4 h-4" />
                New Server
              </span>
            )}
          </div>
        }
      />

      <div className="space-y-3 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3 sm:border-0 sm:bg-transparent sm:p-0">
        <div className="flex items-center gap-2 sm:hidden">
          <button
            onClick={() => setMobileSearchOpen((value) => !value)}
            className={cn("flex h-11 w-11 items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] text-gray-500 dark:text-[#888] transition-colors", mobileSearchOpen && "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]")}
            aria-label="Toggle search"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMobileFiltersOpen((value) => !value)}
            className={cn("inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm text-gray-500 dark:text-[#888] transition-colors", mobileFiltersOpen && "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]")}
          >
            Filters
            <ChevronDown className={cn("h-4 w-4 transition-transform", mobileFiltersOpen && "rotate-180")} />
          </button>
          <div className="ml-auto flex items-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] p-1">
            <button onClick={() => setViewMode("detailed")} className={cn("min-h-[44px] min-w-[44px] rounded-xl px-2 py-1 text-sm transition-colors", viewMode === "detailed" ? "bg-[#0078D4]/15 text-[#4db3ff]" : "text-gray-400 dark:text-[#666]")} title="Detailed cards"><LayoutGrid className="h-4 w-4" /></button>
            <button onClick={() => setViewMode("compact")} className={cn("min-h-[44px] min-w-[44px] rounded-xl px-2 py-1 text-sm transition-colors", viewMode === "compact" ? "bg-[#0078D4]/15 text-[#4db3ff]" : "text-gray-400 dark:text-[#666]")} title="Compact list"><Rows3 className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className={cn("relative min-w-0 flex-1", mobileSearchOpen ? "block" : "hidden sm:block", "sm:min-w-[260px] sm:max-w-sm")}>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-[#555]" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search servers, tags, or groups" className="min-h-[48px] w-full rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] pl-10 pr-4 text-base text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#555] focus:border-[#0078D4]/50 focus:outline-none" />
            <p className="mt-2 text-sm text-gray-500 dark:text-[#777]">Search by server name, game type, tag, or group.</p>
          </div>
          <div className={cn("w-full space-y-3", mobileFiltersOpen ? "block" : "hidden sm:block", "sm:w-auto sm:space-y-2")}>
            <HorizontalScrollHint hint="Swipe filters">
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
                {["all", "running", "starting", "stopped"].map((status) => (
                  <button key={status} onClick={() => setFilterStatus(status)} className={cn("min-h-[44px] rounded-full border px-4 py-2 text-sm font-medium capitalize transition-colors whitespace-nowrap", filterStatus === status ? "border-[#0078D4]/40 bg-[#0078D4]/20 text-[#4db3ff]" : "border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white")}>{status}</button>
                ))}
              </div>
            </HorizontalScrollHint>
            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
              {uniqueGameTypes.length > 1 && (
                <select value={filterType} onChange={(event) => setFilterType(event.target.value)} className="min-h-[48px] rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-base text-gray-700 dark:text-[#d4d4d4] focus:border-[#0078D4]/50 focus:outline-none sm:text-sm">
                  <option value="">All game types</option>
                  {uniqueGameTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              )}
              {allGroups.length > 0 && (
                <select value={filterGroup} onChange={(event) => setFilterGroup(event.target.value)} className="min-h-[48px] rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-base text-gray-700 dark:text-[#d4d4d4] focus:border-[#0078D4]/50 focus:outline-none sm:text-sm">
                  <option value="">All groups</option>
                  {allGroups.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
              )}
              <select value={sortKey} onChange={(event) => setSort(event.target.value as ServerSortKey)} className="min-h-[48px] rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-base text-gray-700 dark:text-[#d4d4d4] focus:border-[#0078D4]/50 focus:outline-none sm:text-sm">
                <option value="health">Sort by health</option>
                <option value="name">Sort by name</option>
                <option value="status">Sort by status</option>
                <option value="cpu">Sort by CPU usage</option>
                <option value="players">Sort by players</option>
                <option value="started">Sort by last started</option>
              </select>
              <div className="hidden items-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] p-1 sm:flex">
                <button onClick={() => setViewMode("detailed")} className={cn("min-h-[44px] min-w-[44px] rounded-xl px-2 py-1 text-sm transition-colors", viewMode === "detailed" ? "bg-[#0078D4]/15 text-[#4db3ff]" : "text-gray-400 dark:text-[#666]")} title="Detailed cards"><LayoutGrid className="h-4 w-4" /></button>
                <button onClick={() => setViewMode("compact")} className={cn("min-h-[44px] min-w-[44px] rounded-xl px-2 py-1 text-sm transition-colors", viewMode === "compact" ? "bg-[#0078D4]/15 text-[#4db3ff]" : "text-gray-400 dark:text-[#666]")} title="Compact list"><Rows3 className="h-4 w-4" /></button>
              </div>
              {(search || filterType || filterTag || filterGroup || filterStatus !== "all") && (
                <button onClick={resetFilters} className="min-h-[48px] rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">Reset filters</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {allTags.length > 0 && (
        <HorizontalScrollHint className={cn(mobileFiltersOpen ? "block" : "hidden sm:block")} hint="Swipe tags and groups">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
            <button onClick={() => setFilterTag("")} className={cn("min-h-[44px] rounded-full border px-4 py-2 text-sm transition-colors whitespace-nowrap", !filterTag ? "border-[#0078D4]/30 bg-[#0078D4]/15 text-[#4db3ff]" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#777] hover:text-gray-700 dark:hover:text-[#ccc]")}>All tags</button>
            {allTags.map((tag) => (
              <button key={tag} onClick={() => setFilterTag((prev) => prev === tag ? "" : tag)} className={cn("min-h-[44px] rounded-full border px-4 py-2 text-sm transition-colors whitespace-nowrap", filterTag === tag ? "border-[#0078D4]/30 bg-[#0078D4]/15 text-[#4db3ff]" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#777] hover:text-gray-700 dark:hover:text-[#ccc]")}>#{tag}</button>
            ))}
            {allGroups.map((group) => (
              <button key={`group-${group}`} onClick={() => setFilterGroup((prev) => prev === group ? "" : group)} className={cn("min-h-[44px] rounded-full border px-4 py-2 text-sm transition-colors whitespace-nowrap", filterGroup === group ? "border-green-500/30 bg-green-500/15 text-green-300" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#777] hover:text-gray-700 dark:hover:text-[#ccc]")}>@{group}</button>
            ))}
          </div>
        </HorizontalScrollHint>
      )}

      {selected.size > 0 && (canBulkStart || canBulkStop || canBulkRestart) && (
        <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] z-40 rounded-3xl border border-[#0078D4]/30 bg-[#0b1a2a]/95 p-4 shadow-2xl backdrop-blur sm:sticky sm:top-16 sm:bottom-auto sm:inset-x-auto sm:rounded-xl">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[#d4e7ff]">{selected.size} selected</span>
            {canBulkStart ? <button onClick={() => doBulkAction("start")} className="min-h-[44px] rounded-2xl bg-green-500/20 px-4 text-sm font-medium text-green-300">Start all</button> : null}
            {canBulkStop ? <button onClick={() => doBulkAction("stop")} className="min-h-[44px] rounded-2xl bg-gray-50 dark:bg-[#252525] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">Stop all</button> : null}
            {canBulkRestart ? <button onClick={() => doBulkAction("restart")} className="min-h-[44px] rounded-2xl bg-gray-50 dark:bg-[#252525] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">Restart all</button> : null}
            <button onClick={() => setSelected(new Set())} className="ml-auto min-h-[44px] rounded-2xl px-3 text-sm font-medium text-[#7cc4ff]">Clear selection</button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-56 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] animate-pulse" />
          ))}
        </div>
      )}

      {setupRequired && !isLoading && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-yellow-500/30 bg-yellow-500/5 p-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-yellow-500/10">
            <Gamepad2 className="h-7 w-7 text-yellow-400" />
          </div>
          <div>
            <p className="text-base font-semibold text-yellow-300">
              {setupReason === "permission_denied" ? "Permission denied" : "Game Hub not set up yet"}
            </p>
            <p className="mt-1 text-sm text-yellow-200/70">
              {setupReason === "permission_denied"
                ? "Your account does not have access to the game-hub namespace. Ask a platform-admin to grant permissions."
                : "The game-hub namespace doesn't exist on the cluster yet. Run the one-time setup to create it."}
            </p>
          </div>
          {setupReason !== "permission_denied" && (
            <Link
              href="/game-hub/setup"
              className="flex items-center gap-2 rounded-lg bg-yellow-500 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-yellow-400"
            >
              Run setup
            </Link>
          )}
        </div>
      )}

      {error && !setupRequired && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-300">
          <AlertTriangle className="h-5 w-5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium">Failed to load servers</p>
            <p className="mt-1 text-sm text-red-200">{error instanceof Error ? error.message : "An unexpected error occurred. Check the console logs."}</p>
          </div>
        </div>
      )}

      {!isLoading && !error && !setupRequired && servers.length === 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-64 rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] gap-4">
          <div className="text-5xl">🎮</div>
          <div className="text-center">
            <p className="text-gray-900 dark:text-[#f2f2f2] font-medium">No game servers yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-[#888]">Deploy your first server to get started.</p>
          </div>
          {canManageGameHub ? (
            <Link href="/game-hub/new" className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" />
              Deploy Server
            </Link>
          ) : null}
        </motion.div>
      )}

      {!isLoading && !error && servers.length > 0 && filteredServers.length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-6 text-center">
          <p className="text-sm text-gray-900 dark:text-[#f2f2f2] font-medium">No servers match the current filters</p>
          <p className="text-xs text-gray-400 dark:text-[#666] mt-1">Try clearing filters, changing the sort order, or searching for a different game.</p>
        </div>
      )}

      <div className={cn("grid gap-3 sm:gap-4", viewMode === "compact" ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3")}>
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
                className={cn("flex flex-col rounded-2xl border bg-white dark:bg-[#1a1a1a] transition-colors", viewMode === "compact" ? "gap-3 p-3 sm:p-4" : "gap-3 p-3 sm:gap-4 sm:p-5", compareMode ? "cursor-pointer" : "cursor-pointer hover:border-[#3a3a3a]", compareSet.has(server.name) ? "border-[#0078D4] ring-1 ring-[#0078D4]/40" : "border-gray-200 dark:border-[#2a2a2a]")}
                onPointerDown={() => startLongPress(server.name)}
                onPointerUp={clearLongPress}
                onPointerLeave={clearLongPress}
                onPointerCancel={clearLongPress}
                onClick={() => {
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  if (compareMode) toggleCompare(server.name);
                  else router.push(`/game-hub/${server.name}`);
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex flex-col items-center gap-2 pt-1">
                      <button onClick={(event) => { event.stopPropagation(); toggleFavorite(server.name); }} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-400 dark:text-[#666] transition-colors hover:border-[#3a3a3a] hover:text-yellow-300" title={favorites.has(server.name) ? "Remove favorite" : "Favorite server"}>
                        <Star className={cn("h-4 w-4", favorites.has(server.name) && "fill-yellow-300 text-yellow-300")} />
                      </button>
                      <button onClick={(event) => { event.stopPropagation(); toggleSelected(server.name); }} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-400 dark:text-[#666] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">
                        {selected.has(server.name) ? <CheckSquare className="h-4 w-4 text-[#0078D4]" /> : <SquareIcon className="h-4 w-4 text-gray-400 dark:text-[#666]" />}
                      </button>
                    </div>
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 dark:bg-[#252525] text-2xl flex-shrink-0">{cardIcon}</div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{server.name}</p>
                        <span className={cn("rounded-full border px-3 py-1 text-sm font-medium capitalize", stoppedStyle)}>{server.status}</span>
                        <span className={cn("rounded-full border px-3 py-1 text-sm font-medium", health.className)}>{server.status === "stopped" ? "Stopped" : `Health ${health.label}`}</span>
                        <span className={cn("rounded-full border px-3 py-1 text-sm font-medium", server.inGit ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-gray-200 dark:border-[#444] bg-gray-50 dark:bg-[#252525] text-gray-600 dark:text-[#b3b3b3]")}>{server.inGit ? "IaC tracked" : "Cluster-only"}</span>
                      </div>
                      <p className="mt-1 text-sm capitalize text-gray-500 dark:text-[#888]">{server.gameType.replace(/-/g, " ")}</p>
                      {server.description ? <p className="mt-2 text-sm text-gray-600 dark:text-[#b3b3b3] line-clamp-2">{server.description}</p> : null}
                      {((server.tags ?? []).length > 0 || (server.groups ?? []).length > 0 || server.imageVersion) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(server.tags ?? []).map((tag) => <span key={tag} className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-1 text-sm text-gray-500 dark:text-[#9e9e9e] sm:text-xs">#{tag}</span>)}
                          {(server.groups ?? []).map((group) => <span key={group} className="rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1 text-sm text-green-300 sm:text-xs">@{group}</span>)}
                          {server.imageVersion && <span className={cn("rounded-full border px-3 py-1 text-sm sm:text-xs", server.imagePinned ? "bg-white dark:bg-[#111] border-gray-200 dark:border-[#2a2a2a] text-gray-500 dark:text-[#9e9e9e]" : "bg-yellow-500/10 border-yellow-500/20 text-yellow-200")}>{server.imagePinned ? `v${server.imageVersion}` : `latest (${server.imageVersion})`}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="hidden flex-shrink-0 items-center gap-1 sm:flex" onClick={(e) => e.stopPropagation()}>
                    {server.status === "stopped" ? (
                      server.permissions?.canStart ? (
                        <button onClick={() => void doAction(server.name, "start")} disabled={!!actionLoading[server.name]} title="Start server" className="flex min-h-[44px] items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/15 px-3 text-sm font-medium text-green-300 transition-colors hover:bg-green-500/25 disabled:opacity-50">
                          {actionLoading[server.name] === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                          <span>Start</span>
                        </button>
                      ) : null
                    ) : (
                      <>
                        {server.permissions?.canAdmin ? (
                          <button onClick={() => void doAction(server.name, "restart")} disabled={!!actionLoading[server.name]} title="Restart" className="flex min-h-[44px] items-center gap-2 rounded-xl bg-[#222] px-3 text-sm text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] hover:text-gray-700 dark:hover:text-[#bbb] disabled:opacity-50">
                            {actionLoading[server.name] === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                            <span>Restart</span>
                          </button>
                        ) : null}
                        {server.permissions?.canStop ? (
                          <button onClick={() => void doAction(server.name, "stop")} disabled={!!actionLoading[server.name]} title="Stop" className="flex min-h-[44px] items-center gap-2 rounded-xl bg-[#222] px-3 text-sm text-gray-500 dark:text-[#888] transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50">
                            {actionLoading[server.name] === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                            <span>Stop</span>
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:hidden">
                  {[
                    { label: "Players", value: String(server.playerCount ?? 0) },
                    { label: "CPU", value: formatUsage(server.cpuUsage, server.cpuLimit, "cpu") },
                    { label: "Memory", value: formatUsage(server.memoryUsage, server.memoryLimit, "memory") },
                    { label: "Replicas", value: replicaSummary(server) },
                  ].map((metric) => (
                    <div key={metric.label} className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                      <p className="text-sm text-gray-500 dark:text-[#777]">{metric.label}</p>
                      <p className="mt-1 text-base font-semibold text-gray-900 dark:text-white">{metric.value}</p>
                    </div>
                  ))}
                </div>
                <div className={cn("hidden gap-2 text-sm text-gray-500 dark:text-[#888] sm:grid", viewMode === "compact" ? "sm:grid-cols-2 lg:grid-cols-5" : "sm:grid-cols-2")}>
                  <div>Port: <span className="text-gray-700 dark:text-[#d4d4d4]">{server.nodePort || server.port || "—"}</span></div>
                  <div>Memory: <span className="text-gray-700 dark:text-[#d4d4d4]">{server.memory || "—"}</span></div>
                  <div>CPU: <span className="text-gray-700 dark:text-[#d4d4d4]">{server.cpu || "—"}</span></div>
                  <div>Players: <span className="text-gray-700 dark:text-[#d4d4d4]">{server.playerCount ?? 0}</span></div>
                  <div>Last restart: <span className="text-gray-700 dark:text-[#d4d4d4]">{server.podStartTime ? timeAgo(server.podStartTime) : "—"}</span></div>
                  <div>Replicas: <span className="text-gray-700 dark:text-[#d4d4d4]">{replicaSummary(server)}</span></div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:hidden" onClick={(event) => event.stopPropagation()}>
                  <Link href={`/game-hub/${server.name}`} className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-[rgba(0,120,212,0.15)] px-4 text-sm font-semibold text-[#4db3ff] transition-colors hover:bg-[rgba(0,120,212,0.25)]">
                    <Terminal className="h-4 w-4" /> {server.permissions?.canConsole ? "Console" : "Details"}
                  </Link>
                  <button onClick={() => openServerActions(server.name)} className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white">
                    <MoreVertical className="h-4 w-4" /> Actions
                  </button>
                </div>
                <div className="hidden items-center gap-2 flex-wrap sm:flex" onClick={(event) => event.stopPropagation()}>
                  {server.status === "stopped" ? (
                    server.permissions?.canStart ? (
                      <button onClick={() => void doAction(server.name, "start")} disabled={!!actionLoading[server.name]} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-green-500/20 px-4 text-sm font-medium text-green-300 transition-colors hover:bg-green-500/30 disabled:opacity-50">
                        {actionLoading[server.name] === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start
                      </button>
                    ) : null
                  ) : (
                    <>
                      {server.permissions?.canStop ? (
                        <button onClick={() => void doAction(server.name, "stop")} disabled={!!actionLoading[server.name]} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gray-50 dark:bg-[#252525] px-4 text-sm font-medium text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] disabled:opacity-50">
                          {actionLoading[server.name] === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} Stop
                        </button>
                      ) : null}
                      {server.permissions?.canAdmin ? (
                        <button onClick={() => void doAction(server.name, "restart")} disabled={!!actionLoading[server.name]} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gray-50 dark:bg-[#252525] px-4 text-sm font-medium text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] disabled:opacity-50">
                          {actionLoading[server.name] === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Restart
                        </button>
                      ) : null}
                    </>
                  )}
                  {server.permissions?.canAdmin ? (
                    <button onClick={() => void cloneServer(server.name)} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gray-50 dark:bg-[#252525] px-4 text-sm font-medium text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a]">Clone</button>
                  ) : null}
                  <Link href={`/game-hub/${server.name}`} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-[rgba(0,120,212,0.15)] px-4 text-sm font-medium text-[#0078D4] transition-colors hover:bg-[rgba(0,120,212,0.25)]">
                    <Terminal className="h-4 w-4" /> {server.permissions?.canConsole ? "Console" : "View"}
                  </Link>
                  {server.permissions?.canAdmin ? (
                    <button onClick={() => { if (confirm(`Delete ${server.name}? This will remove the server and its data.`)) void doAction(server.name, "delete"); }} disabled={!!actionLoading[server.name]} className="ml-auto flex min-h-[44px] items-center gap-2 rounded-xl bg-red-500/10 px-4 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50">
                      {actionLoading[server.name] === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
                    </button>
                  ) : null}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {compareMode && comparedServers.length >= 2 && (
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
            <BarChart2 className="w-4 h-4 text-[#4db3ff]" />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Server Comparison</p>
              <p className="text-xs text-gray-400 dark:text-[#666]">Compare up to three servers side by side.</p>
            </div>
          </div>
          <div className="space-y-3 p-3 sm:hidden">
            {comparedServers.map((server) => (
              <div key={server.name} className="rounded-xl border border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#0d0d0d] p-3 text-sm text-gray-700 dark:text-[#d4d4d4]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="font-medium text-gray-900 dark:text-[#f2f2f2]">{server.icon ?? server.gameType[0]?.toUpperCase() ?? "🎮"} {server.name}</p>
                  <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] px-3 py-1 text-sm uppercase text-gray-500 dark:text-[#888]">{server.status}</span>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-gray-400 dark:text-[#666]">Game</dt><dd className="mt-1">{server.gameType}</dd></div>
                  <div><dt className="text-gray-400 dark:text-[#666]">Players</dt><dd className="mt-1">{server.playerCount ?? 0}</dd></div>
                  <div><dt className="text-gray-400 dark:text-[#666]">Replicas</dt><dd className="mt-1">{replicaSummary(server)}</dd></div>
                  <div><dt className="text-gray-400 dark:text-[#666]">Restarts</dt><dd className="mt-1">{server.restartCount ?? 0}</dd></div>
                  <div><dt className="text-gray-400 dark:text-[#666]">CPU</dt><dd className="mt-1">{formatUsage(server.cpuUsage, server.cpuLimit, "cpu")}</dd></div>
                  <div><dt className="text-gray-400 dark:text-[#666]">Memory</dt><dd className="mt-1">{formatUsage(server.memoryUsage, server.memoryLimit, "memory")}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-white dark:bg-[#0d0d0d]">
                <tr>
                  <th className="text-left px-4 py-3 text-xs uppercase tracking-wide text-gray-400 dark:text-[#666]">Metric</th>
                  {comparedServers.map((server) => (
                    <th key={server.name} className="text-left px-4 py-3 text-xs uppercase tracking-wide text-gray-500 dark:text-[#888]">{server.icon ?? server.gameType[0]?.toUpperCase() ?? "🎮"} {server.name}</th>
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
                  <tr key={row.label} className="border-t border-gray-200 dark:border-[#1e1e1e]">
                    <td className="px-4 py-3 text-gray-400 dark:text-[#666] text-xs uppercase tracking-wide">{row.label}</td>
                    {comparedServers.map((server) => (
                      <td key={`${row.label}-${server.name}`} className="px-4 py-3 text-gray-700 dark:text-[#d4d4d4]">{row.render(server)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mobile FAB handled by context-aware FloatingActionButton in layout */}

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <button onClick={() => setShowRoadmap((prev) => !prev)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left border-b border-gray-200 dark:border-[#1e1e1e]">
          <div className="flex items-start gap-3">
            <BookOpen className="w-4 h-4 text-[#4db3ff] mt-0.5" />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Feature Roadmap</p>
              <p className="text-xs text-gray-400 dark:text-[#666] mt-0.5">100 ideas across 10 categories, with shipped game hub features highlighted.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-gray-400 dark:text-[#666]">
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d]">{FEATURE_ROADMAP.reduce((sum, category) => sum + category.items.length, 0)} items</span>
            {showRoadmap ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </button>
        {showRoadmap && (
          <div className="p-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {FEATURE_ROADMAP.map((category) => (
              <div key={category.category} className="rounded-xl border border-gray-200 dark:border-[#1e1e1e] bg-[#0b0b0b] p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-gray-900 dark:text-[#f2f2f2] uppercase tracking-wide">{category.category}</p>
                  <span className="text-[10px] text-gray-400 dark:text-[#444]">{category.items.length}/10</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {category.items.map((feature) => (
                    <div key={feature.name} className="rounded-lg border border-[#1d1d1d] bg-white dark:bg-[#111] px-2.5 py-2">
                      <div className="flex items-start gap-2">
                        <span className={cn("mt-0.5 text-[11px] leading-none", feature.status === "Shipped" ? "text-green-400" : "text-gray-700 dark:text-[#333]")}>{feature.status === "Shipped" ? "✓" : "•"}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-gray-700 dark:text-[#d4d4d4] leading-snug">{feature.name}</p>
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
