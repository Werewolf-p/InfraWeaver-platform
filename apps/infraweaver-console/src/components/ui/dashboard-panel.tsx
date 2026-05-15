import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DashboardPanelProps {
  title: string;
  description?: string;
  icon?: ElementType;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function DashboardPanel({ title, description, icon: Icon, actions, children, className, contentClassName }: DashboardPanelProps) {
  return (
    <section className={cn("rounded-2xl border border-[#2a2a2a] bg-[#111] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.2)] md:p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {Icon ? <Icon className="h-4 w-4 text-[#9dcbff]" /> : null}
            <h2 className="text-base font-semibold text-[#f2f2f2]">{title}</h2>
          </div>
          {description ? <p className="mt-1 text-sm text-[#888]">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn("mt-4", contentClassName)}>{children}</div>
    </section>
  );
}
