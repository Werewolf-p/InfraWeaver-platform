import { cn } from "@/lib/utils";

interface ResourceBarProps {
  value: number;
  max: number;
  label?: string;
  className?: string;
  valueFormatter?: (value: number, max: number, percentage: number) => string;
  tone?: "auto" | "emerald" | "amber" | "red" | "blue";
}

const TONE_STYLES = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-blue-500",
} as const;

function resolveTone(percentage: number, tone: ResourceBarProps["tone"]) {
  if (tone && tone !== "auto") return TONE_STYLES[tone];
  if (percentage >= 90) return TONE_STYLES.red;
  if (percentage >= 70) return TONE_STYLES.amber;
  return TONE_STYLES.emerald;
}

export function ResourceBar({
  value,
  max,
  label,
  className,
  tone = "auto",
  valueFormatter,
}: ResourceBarProps) {
  const percentage = max > 0 ? Math.min(Math.round((value / max) * 100), 100) : 0;
  const fillClassName = resolveTone(percentage, tone);
  const summary = valueFormatter?.(value, max, percentage) ?? `${value}/${max}`;

  return (
    <div className={cn("space-y-1.5", className)}>
      {(label || summary) && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span>{label}</span>
          <span>{summary}</span>
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-white/10">
        <div className={cn("h-full rounded-full transition-all", fillClassName)} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}
