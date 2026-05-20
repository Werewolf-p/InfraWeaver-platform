"use client";
import { cn } from "@/lib/utils";

type StatusVariant = "healthy" | "online" | "syncing" | "degraded" | "unknown" | "warning" | "offline" | "progressing";
type StatusSize = "sm" | "md" | "lg";

interface StatusBadgeProps {
  variant: StatusVariant;
  label?: string;
  size?: StatusSize;
  dot?: boolean;
  className?: string;
}

const variantConfig: Record<StatusVariant, { dot: string; text: string; bg: string; border: string; pulse: string }> = {
  healthy:     { dot: "bg-green-500",  text: "text-green-400",  bg: "bg-green-500/10",  border: "border-green-500/20",  pulse: "animate-[pulse_2s_ease-in-out_infinite]" },
  online:      { dot: "bg-green-500",  text: "text-green-400",  bg: "bg-green-500/10",  border: "border-green-500/20",  pulse: "animate-[pulse_2s_ease-in-out_infinite]" },
  syncing:     { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/20", pulse: "animate-[pulse_0.5s_ease-in-out_infinite]" },
  progressing: { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/20", pulse: "animate-[pulse_0.5s_ease-in-out_infinite]" },
  degraded:    { dot: "bg-red-500",    text: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/20",    pulse: "animate-[pulse_1s_ease-in-out_infinite]" },
  warning:     { dot: "bg-orange-500", text: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/20", pulse: "animate-[pulse_1.5s_ease-in-out_infinite]" },
  offline:     { dot: "bg-red-500",    text: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/20",    pulse: "" },
  unknown:     { dot: "bg-slate-500",  text: "text-slate-500 dark:text-slate-400",  bg: "bg-slate-500/10",  border: "border-slate-500/20",  pulse: "" },
};

const sizeConfig: Record<StatusSize, { badge: string; dot: string; text: string }> = {
  sm: { badge: "px-1.5 py-0.5 gap-1",  dot: "w-1.5 h-1.5", text: "text-[10px]" },
  md: { badge: "px-2 py-1 gap-1.5",    dot: "w-2 h-2",     text: "text-xs" },
  lg: { badge: "px-2.5 py-1.5 gap-2",  dot: "w-2.5 h-2.5", text: "text-sm" },
};

export function StatusBadge({ variant, label, size = "md", dot = true, className }: StatusBadgeProps) {
  const v = variantConfig[variant];
  const s = sizeConfig[size];
  const displayLabel = label ?? variant.charAt(0).toUpperCase() + variant.slice(1);

  return (
    <span className={cn(
      "inline-flex items-center rounded-full border font-medium",
      v.bg, v.border, v.text,
      s.badge, s.text,
      className
    )}>
      {dot && (
        <span className="relative flex flex-shrink-0" style={{ width: s.dot.split(" ")[0].replace("w-","") + "rem" === "1.5rem" ? "6px" : "8px", height: s.dot.split(" ")[0].replace("w-","") === "w-1.5" ? "6px" : "8px" }}>
          <span className={cn("absolute inset-0 rounded-full opacity-75", v.dot, v.pulse)} />
          <span className={cn("relative rounded-full", v.dot, s.dot)} />
        </span>
      )}
      {displayLabel}
    </span>
  );
}
