"use client";

import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function formatRelative(date: Date): string {
  const now = Date.now();
  const diff = Math.floor((now - date.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
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
      setRelative(parsed ? formatRelative(parsed) : "—");
      return;
    }

    setRelative(formatRelative(parsed));
    const interval = setInterval(() => setRelative(formatRelative(parsed)), 30_000);
    return () => clearInterval(interval);
  }, [parsed, live]);

  if (!parsed) return <span className={cn("text-[#555]", className)}>—</span>;

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
