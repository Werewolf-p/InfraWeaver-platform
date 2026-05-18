import { cn } from "@/lib/utils";

interface Segment {
  label: string;
  value: number;
  className?: string;
}

interface SegmentedBarProps {
  segments: Segment[];
  className?: string;
}

export function SegmentedBar({ segments, className }: SegmentedBarProps) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-3 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
        {segments.map((segment) => {
          const width = total > 0 ? Math.max((segment.value / total) * 100, segment.value > 0 ? 6 : 0) : 0;
          return (
            <div
              key={segment.label}
              className={cn("h-full", segment.className || "bg-[#0078D4]")}
              style={{ width: `${width}%` }}
              title={`${segment.label}: ${segment.value}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-[#888]">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2">
            <span className={cn("h-2.5 w-2.5 rounded-full", segment.className || "bg-[#0078D4]")} />
            <span>{segment.label}</span>
            <span className="text-gray-900 dark:text-[#f2f2f2]">{segment.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
