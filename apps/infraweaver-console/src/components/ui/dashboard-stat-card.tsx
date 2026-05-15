import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DashboardStatCardProps {
  label: string;
  value: string | number;
  icon?: ElementType;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  description?: string;
  footer?: ReactNode;
  className?: string;
}

const toneStyles: Record<NonNullable<DashboardStatCardProps["tone"]>, string> = {
  neutral: "border-[#2a2a2a] bg-[#141414] text-[#f2f2f2]",
  info: "border-[#0078D4]/20 bg-[rgba(0,120,212,0.08)] text-[#f2f2f2]",
  success: "border-emerald-500/20 bg-emerald-500/10 text-[#f2f2f2]",
  warning: "border-amber-500/20 bg-amber-500/10 text-[#f2f2f2]",
  danger: "border-red-500/20 bg-red-500/10 text-[#f2f2f2]",
};

export function DashboardStatCard({ label, value, icon: Icon, tone = "neutral", description, footer, className }: DashboardStatCardProps) {
  return (
    <div className={cn("rounded-2xl border p-4", toneStyles[tone], className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#888]">{label}</p>
          <p className="mt-3 text-2xl font-semibold text-current">{value}</p>
        </div>
        {Icon ? <Icon className="h-5 w-5 text-current opacity-80" /> : null}
      </div>
      {description ? <p className="mt-2 text-sm text-[#b8b8b8]">{description}</p> : null}
      {footer ? <div className="mt-3 text-xs text-[#888]">{footer}</div> : null}
    </div>
  );
}
