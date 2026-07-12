"use client";
import { cn } from "@/lib/utils";

interface KubeOfflineBannerProps {
  /** Render nothing when false — pass `data?.live === false` directly. Default true. */
  show?: boolean;
  /** What could not be loaded, e.g. "cluster events" or "secret data". */
  resource?: string;
  /** Trailing hint. Default "Check cluster connectivity." */
  hint?: string;
  /** Full custom message — overrides `resource`/`hint` when provided. */
  message?: string;
  className?: string;
}

/**
 * Amber "Kubernetes unavailable" notice — shared copy of the identical
 * offline banners on the events, secrets, config-maps, ingress, cronjobs,
 * and routes pages.
 */
export function KubeOfflineBanner({
  show = true,
  resource = "data",
  hint = "Check cluster connectivity.",
  message,
  className,
}: KubeOfflineBannerProps) {
  if (!show) return null;
  return (
    <div className={cn("rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200", className)}>
      {message ?? `Kubernetes unavailable — ${resource} cannot be loaded. ${hint}`}
    </div>
  );
}
