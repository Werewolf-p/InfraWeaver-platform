"use client";

import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitBranch,
  HelpCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";

export type StatusType =
  | "running"
  | "pending"
  | "failed"
  | "unknown"
  | "healthy"
  | "degraded"
  | "synced"
  | "outOfSync"
  | "processing"
  | "online"
  | "syncing"
  | "warning"
  | "offline"
  | "progressing";

type BadgeVariant = "pill" | "card";
type BadgeSize = "sm" | "md" | "lg";

export interface StatusBadgeProps {
  status: StatusType | string;
  label?: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  showIcon?: boolean;
  showDot?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<
  StatusType,
  {
    icon: React.ElementType;
    colors: { bg: string; border: string; text: string; dot: string };
    label: string;
    pulse: boolean;
  }
> = {
  running: {
    icon: Activity,
    colors: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400" },
    label: "Running",
    pulse: true,
  },
  healthy: {
    icon: CheckCircle2,
    colors: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400" },
    label: "Healthy",
    pulse: true,
  },
  online: {
    icon: CheckCircle2,
    colors: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400" },
    label: "Online",
    pulse: true,
  },
  synced: {
    icon: GitBranch,
    colors: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400" },
    label: "Synced",
    pulse: false,
  },
  pending: {
    icon: Clock,
    colors: { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400", dot: "bg-blue-400" },
    label: "Pending",
    pulse: true,
  },
  processing: {
    icon: RefreshCw,
    colors: { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400", dot: "bg-blue-400" },
    label: "Processing",
    pulse: true,
  },
  syncing: {
    icon: RefreshCw,
    colors: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
    label: "Syncing",
    pulse: true,
  },
  degraded: {
    icon: AlertTriangle,
    colors: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
    label: "Degraded",
    pulse: false,
  },
  warning: {
    icon: AlertTriangle,
    colors: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
    label: "Warning",
    pulse: false,
  },
  progressing: {
    icon: RefreshCw,
    colors: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
    label: "Progressing",
    pulse: true,
  },
  outOfSync: {
    icon: GitBranch,
    colors: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
    label: "Out of Sync",
    pulse: false,
  },
  failed: {
    icon: XCircle,
    colors: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", dot: "bg-red-400" },
    label: "Failed",
    pulse: false,
  },
  offline: {
    icon: XCircle,
    colors: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", dot: "bg-red-400" },
    label: "Offline",
    pulse: false,
  },
  unknown: {
    icon: HelpCircle,
    colors: { bg: "bg-slate-500/10", border: "border-slate-500/30", text: "text-slate-400", dot: "bg-slate-400" },
    label: "Unknown",
    pulse: false,
  },
};

const SIZE_CONFIG: Record<BadgeSize, { text: string; px: string; icon: string }> = {
  sm: { text: "text-[10px]", px: "px-1.5 py-0.5", icon: "w-3 h-3" },
  md: { text: "text-xs", px: "px-2 py-1", icon: "w-3.5 h-3.5" },
  lg: { text: "text-sm", px: "px-2.5 py-1.5", icon: "w-4 h-4" },
};

export function normalizeStatus(status: string): StatusType {
  const normalized = status.replace(/\s+/g, "").toLowerCase();

  if (normalized.includes("outofsync")) return "outOfSync";
  if (normalized.includes("synced")) return "synced";
  if (normalized.includes("degraded")) return "degraded";
  if (normalized.includes("progressing")) return "progressing";
  if (normalized.includes("syncing")) return "syncing";
  if (normalized.includes("processing")) return "processing";
  if (normalized.includes("warning") || normalized.includes("backoff")) return "warning";
  if (normalized.includes("offline")) return "offline";
  if (normalized.includes("online")) return "online";
  if (normalized.includes("failed") || normalized.includes("error") || normalized.includes("notready")) return "failed";
  if (normalized.includes("pending") || normalized.includes("creating")) return "pending";
  if (normalized.includes("running")) return "running";
  if (normalized.includes("healthy") || normalized.includes("ready")) return "healthy";
  return "unknown";
}

export function StatusBadge({
  status,
  label,
  variant = "pill",
  size = "md",
  showIcon = false,
  showDot = true,
  className,
}: StatusBadgeProps) {
  const normalizedStatus = normalizeStatus(status);
  const config = STATUS_CONFIG[normalizedStatus] ?? STATUS_CONFIG.unknown;
  const sz = SIZE_CONFIG[size];
  const displayLabel = label ?? config.label;
  const Icon = config.icon;

  if (variant === "card") {
    return (
      <div className={cn("flex items-center gap-2.5 rounded-xl border p-3", config.colors.bg, config.colors.border, className)}>
        <div className={cn("relative flex-shrink-0", config.colors.text)}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className={cn("text-sm font-semibold", config.colors.text)}>{displayLabel}</p>
        </div>
        {config.pulse && (
          <div className="relative ml-auto flex-shrink-0">
            <span className={cn("absolute inset-0 rounded-full opacity-60 animate-ping", config.colors.dot)} />
            <span className={cn("relative block h-2 w-2 rounded-full", config.colors.dot)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        config.colors.bg,
        config.colors.border,
        config.colors.text,
        sz.px,
        sz.text,
        className,
      )}
    >
      {showDot ? (
        <span className="relative flex h-2 w-2 flex-shrink-0 items-center justify-center">
          {config.pulse ? (
            <>
              <span className={cn("absolute inset-0 rounded-full opacity-60 animate-ping", config.colors.dot)} />
              <span className={cn("relative h-full w-full rounded-full", config.colors.dot)} />
            </>
          ) : (
            <span className={cn("h-full w-full rounded-full", config.colors.dot)} />
          )}
        </span>
      ) : null}
      {showIcon ? <Icon className={sz.icon} /> : null}
      {displayLabel}
    </span>
  );
}
