"use client";
import { memo, useMemo } from "react";

interface TimelinePoint { timestamp: string; status: string; latencyMs: number; }
interface Props { data: TimelinePoint[]; }

interface SegmentBarProps { point: TimelinePoint; }

const STATUS_CLASS: Record<string, string> = {
  up: "bg-green-500/70",
  degraded: "bg-yellow-500/70",
};

const SegmentBar = memo(function SegmentBar({ point }: SegmentBarProps) {
  const label = `${new Date(point.timestamp).toLocaleTimeString()} - ${point.status} (${point.latencyMs}ms)`;
  const colorClass = STATUS_CLASS[point.status] ?? "bg-red-500/70";
  return (
    <div
      title={label}
      className={`flex-1 rounded-sm ${colorClass}`}
    />
  );
});

export function HealthTimeline({ data }: Props) {
  const uptime = useMemo(() => {
    if (data.length === 0) return "100.00";
    const upCount = data.reduce((n, d) => n + (d.status === "up" ? 1 : 0), 0);
    return ((upCount / data.length) * 100).toFixed(2);
  }, [data]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-500 dark:text-slate-400">Last 24h Uptime</span>
        <span className="text-sm font-semibold text-green-400">{uptime}%</span>
      </div>
      <div className="flex gap-px h-8">
        {data.map((point, i) => (
          <SegmentBar key={i} point={point} />
        ))}
      </div>
      <div className="flex gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/70 inline-block" />Up</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-yellow-500/70 inline-block" />Degraded</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/70 inline-block" />Down</span>
      </div>
    </div>
  );
}
