"use client";
import { Loader2, Play, Plus, RotateCcw, Square, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ServerPowerAction = "start" | "restart" | "stop" | "clone" | "delete";

export interface ServerPowerActionDescriptor {
  action: ServerPowerAction;
  label: string;
  icon: LucideIcon;
  tone: "success" | "neutral" | "danger";
}

/**
 * Canonical descriptor for game-server power actions — labels, icons, and
 * tones matching the buttons on the game-hub list and detail pages.
 */
export const serverPowerActions: readonly ServerPowerActionDescriptor[] = [
  { action: "start", label: "Start", icon: Play, tone: "success" },
  { action: "restart", label: "Restart", icon: RotateCcw, tone: "neutral" },
  { action: "stop", label: "Stop", icon: Square, tone: "neutral" },
  { action: "clone", label: "Clone", icon: Plus, tone: "neutral" },
  { action: "delete", label: "Delete", icon: Trash2, tone: "danger" },
];

const TONE_CLASSES: Record<ServerPowerActionDescriptor["tone"], string> = {
  success: "bg-green-500/20 text-green-300 hover:bg-green-500/30",
  neutral: "bg-gray-50 dark:bg-[#252525] text-gray-500 dark:text-[#9e9e9e] hover:bg-gray-100 dark:hover:bg-[#2a2a2a]",
  danger: "ml-auto bg-red-500/10 text-red-400 hover:bg-red-500/20",
};

export interface ServerActionPermissions {
  canStart?: boolean;
  canStop?: boolean;
  canAdmin?: boolean;
}

interface ServerActionButtonsProps {
  /** Current server status — "stopped" shows Start, anything else shows Stop/Restart. */
  status: string;
  /** Which action is currently in flight (disables the row, spins that button's icon). */
  loadingAction?: ServerPowerAction | null;
  onAction: (action: ServerPowerAction) => void | Promise<void>;
  /** Per-server permissions; omitted flags default to allowed. */
  permissions?: ServerActionPermissions;
  /** Hide the clone/delete admin actions regardless of permissions. */
  showClone?: boolean;
  showDelete?: boolean;
  className?: string;
}

/**
 * Start / Stop / Restart / Clone / Delete action row for a game server —
 * shared copy of the button clusters on the game-hub list page. Rendering
 * rules match the originals: stopped servers offer Start; running servers
 * offer Stop and Restart; Clone and Delete require admin.
 */
export function ServerActionButtons({
  status,
  loadingAction = null,
  onAction,
  permissions,
  showClone = true,
  showDelete = true,
  className,
}: ServerActionButtonsProps) {
  const canStart = permissions?.canStart ?? true;
  const canStop = permissions?.canStop ?? true;
  const canAdmin = permissions?.canAdmin ?? true;
  const isStopped = status === "stopped";

  const visible = serverPowerActions.filter((descriptor) => {
    switch (descriptor.action) {
      case "start":
        return isStopped && canStart;
      case "stop":
        return !isStopped && canStop;
      case "restart":
        return !isStopped && canAdmin;
      case "clone":
        return showClone && canAdmin;
      case "delete":
        return showDelete && canAdmin;
    }
  });

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {visible.map((descriptor) => {
        const Icon = descriptor.icon;
        return (
          <button
            key={descriptor.action}
            type="button"
            onClick={() => void onAction(descriptor.action)}
            disabled={!!loadingAction}
            className={cn(
              "flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:opacity-50",
              TONE_CLASSES[descriptor.tone],
            )}
          >
            {loadingAction === descriptor.action ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
            {descriptor.label}
          </button>
        );
      })}
    </div>
  );
}
