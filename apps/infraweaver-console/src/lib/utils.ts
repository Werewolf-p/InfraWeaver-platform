import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { INTERNAL_DOMAIN } from "@/lib/domain";

const ESCAPED_INTERNAL_DOMAIN = INTERNAL_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Redacts cluster-internal hostnames (svc, cluster.local, and the platform's
// own internal domain) from user-facing error messages. The internal domain is
// env-derived so forks redact their own domain, not a hardcoded one.
const INTERNAL_HOST_PATTERN = new RegExp(
  `\\b(?:localhost|(?:[a-z0-9-]+\\.)+(?:svc(?:\\.cluster\\.local)?|cluster\\.local|${ESCAPED_INTERNAL_DOMAIN}))(?::\\d{1,5})?\\b`,
  "gi",
);

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
  unknown: { bg: "bg-slate-500/10", border: "border-slate-500/30", text: "text-slate-500 dark:text-slate-400", dot: "bg-slate-400" },
};

export function statusColor(status: string) {
  const s = status.toLowerCase();
  if (s.includes("healthy") || s.includes("running") || s.includes("synced")) return STATUS_COLORS.healthy;
  if (s.includes("degraded") || s.includes("pending") || s.includes("warning")) return STATUS_COLORS.degraded;
  if (s.includes("failed") || s.includes("error") || s.includes("not ready")) return STATUS_COLORS.failed;
  return STATUS_COLORS.unknown;
}


const SAFE_ERROR_SUBSTRINGS = [
  "unauthorized",
  "forbidden",
  "not found",
  "already exists",
  "rate limit",
  "invalid",
  "required",
  "timeout",
  "too long",
  "not allowed",
  "rejected",
  "failed",
  "unavailable",
  "network",
  "dns",
  "connection",
  "conflict",
];

/**
 * UserError: thrown for user-facing validation/compatibility errors that are
 * safe to display as-is (no internal paths, IPs, or secrets). These bypass the
 * SAFE_ERROR_SUBSTRINGS allowlist in safeError() and are always shown to users.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

function redactErrorMessage(message: string) {
  return message
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(INTERNAL_HOST_PATTERN, "[internal]")
    .replace(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d{1,5})?\b/g, "[internal]")
    .replace(/\b(?:[A-Z]:\\|\/)[\w./\\-]+/g, "[path]")
    .replace(/\s+at\s+[^\n]+/g, "")
    .trim();
}

export function safeError(e: unknown): string {
  // UserError messages are always safe to show as-is (caller is responsible for content)
  if (e instanceof UserError) return e.message;

  // Extract message string from various error shapes
  let message = "";

  if (e instanceof Error) {
    message = e.message;
  } else if (typeof e === "string") {
    message = e;
  } else if (e && typeof e === "object") {
    // @kubernetes/client-node v1.x throws ResponseError with body property
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") {
      message = obj.message;
    } else if (obj.body && typeof obj.body === "object") {
      const body = obj.body as Record<string, unknown>;
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.reason === "string") message = `${body.reason}${body.code ? ` (${body.code})` : ""}`;
    } else if (typeof obj.statusCode === "number") {
      message = `HTTP ${obj.statusCode}`;
    }
  }

  if (!message) return process.env.NODE_ENV === "production" ? "Internal error" : "An error occurred";

  const redacted = redactErrorMessage(message);
  if (!redacted) return process.env.NODE_ENV === "production" ? "Internal error" : "An error occurred";
  if (process.env.NODE_ENV !== "production") return redacted;

  const normalized = redacted.toLowerCase();
  return SAFE_ERROR_SUBSTRINGS.some((entry) => normalized.includes(entry)) ? redacted : "Internal error";
}
