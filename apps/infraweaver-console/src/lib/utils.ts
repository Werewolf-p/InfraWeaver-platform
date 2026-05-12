import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function timeAgo(date: string | Date): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function formatDate(date: string | Date, includeTime = true): string {
  const d = new Date(date);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const base = `${months[d.getMonth()]} ${d.getDate()}`;
  if (!includeTime) return base;
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${base}, ${h}:${m}`;
}

export const STATUS_COLORS = {
  healthy: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400" },
  degraded: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
  failed: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", dot: "bg-red-400" },
  pending: { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400", dot: "bg-blue-400" },
  unknown: { bg: "bg-slate-500/10", border: "border-slate-500/30", text: "text-slate-400", dot: "bg-slate-400" },
};

export function statusColor(status: string) {
  const s = status.toLowerCase();
  if (s.includes("healthy") || s.includes("running") || s.includes("synced")) return STATUS_COLORS.healthy;
  if (s.includes("degraded") || s.includes("pending") || s.includes("warning")) return STATUS_COLORS.degraded;
  if (s.includes("failed") || s.includes("error") || s.includes("not ready")) return STATUS_COLORS.failed;
  return STATUS_COLORS.unknown;
}


export function safeError(e: unknown): string {
  if (e instanceof Error) return e.message.replace(/https?:\/\/[\w.:-]+/g, "[internal]");
  return "An error occurred";
}
