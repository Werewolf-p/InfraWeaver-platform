import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface DataCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down";
  className?: string;
}

export function DataCard({ title, value, subtitle, trend, className }: DataCardProps) {
  return (
    <div className={cn("rounded-xl border border-[#2a2a2a] bg-[#111] p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#888]">{title}</p>
        {trend === "up" ? (
          <TrendingUp className="h-4 w-4 text-emerald-400" />
        ) : trend === "down" ? (
          <TrendingDown className="h-4 w-4 text-red-400" />
        ) : null}
      </div>
      <p className="mt-3 text-2xl font-semibold text-[#f2f2f2]">{value}</p>
      {subtitle ? <p className="mt-1 text-sm text-[#888]">{subtitle}</p> : null}
    </div>
  );
}
