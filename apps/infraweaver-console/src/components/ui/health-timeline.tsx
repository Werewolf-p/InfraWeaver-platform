"use client";
interface TimelinePoint { timestamp: string; status: string; latencyMs: number; }
interface Props { data: TimelinePoint[]; }
export function HealthTimeline({ data }: Props) {
  const upCount = data.filter(d => d.status === "up").length;
  const uptime = data.length > 0 ? ((upCount / data.length) * 100).toFixed(2) : "100.00";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-400">Last 24h Uptime</span>
        <span className="text-sm font-semibold text-green-400">{uptime}%</span>
      </div>
      <div className="flex gap-px h-8">
        {data.map((point, i) => (
          <div
            key={i}
            title={`${new Date(point.timestamp).toLocaleTimeString()} - ${point.status} (${point.latencyMs}ms)`}
            className={`flex-1 rounded-sm ${point.status === "up" ? "bg-green-500/70" : point.status === "degraded" ? "bg-yellow-500/70" : "bg-red-500/70"}`}
          />
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
