"use client";

import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function formatRelative(date: Date): string {
  // Symmetric past/future: a timestamp in the future (cert expiry, a cronjob's
  // next run, a scheduled task) must read "in 2d", not collapse to "just now"
  // because the raw diff went negative.
  const deltaSeconds = Math.floor((Date.now() - date.getTime()) / 1000);
  const diff = Math.abs(deltaSeconds);
  if (diff < 5) return "just now";
  const wrap = (value: string) => (deltaSeconds < 0 ? `in ${value}` : `${value} ago`);
  if (diff < 60) return wrap(`${diff}s`);
  if (diff < 3600) return wrap(`${Math.floor(diff / 60)}m`);
  if (diff < 86400) return wrap(`${Math.floor(diff / 3600)}h`);
  if (diff < 604800) return wrap(`${Math.floor(diff / 86400)}d`);
  return date.toLocaleDateString();
}

interface RelativeTimeProps {
  date: Date | string | null | undefined;
  className?: string;
  live?: boolean;
}

export function RelativeTime({ date, className, live = true }: RelativeTimeProps) {
  const parsed = useMemo(() => {
    if (!date) return null;
    const value = new Date(date);
    return Number.isNaN(value.getTime()) ? null : value;
  }, [date]);
  const [relative, setRelative] = useState(() => (parsed ? formatRelative(parsed) : "—"));

  useEffect(() => {
    if (!parsed || !live) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with an external/browser store or dependency-driven reset; not derived render state
      setRelative(parsed ? formatRelative(parsed) : "—");
      return;
    }

    setRelative(formatRelative(parsed));
    const interval = setInterval(() => setRelative(formatRelative(parsed)), 30_000);
    return () => clearInterval(interval);
  }, [parsed, live]);

  if (!parsed) return <span className={cn("text-gray-400 dark:text-[#8a8a8a]", className)}>—</span>;

  const absolute = parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  return (
    <Tooltip content={absolute} position="top">
      <time dateTime={parsed.toISOString()} className={cn("cursor-default text-inherit", className)}>
        {relative}
      </time>
    </Tooltip>
  );
}
