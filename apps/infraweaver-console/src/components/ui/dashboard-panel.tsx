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
    <section className={cn("rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur md:p-5 dark:border-[#2a2a2a] dark:bg-[#111] dark:shadow-[0_20px_60px_rgba(0,0,0,0.2)]", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/80 pb-4 dark:border-white/5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {Icon ? <Icon className="h-4 w-4 text-sky-600 dark:text-[#9dcbff]" /> : null}
            <h2 className="text-base font-semibold text-slate-950 dark:text-[#f2f2f2]">{title}</h2>
          </div>
          {description ? <p className="mt-1 text-sm text-slate-500 dark:text-[#888]">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn("mt-4", contentClassName)}>{children}</div>
    </section>
  );
}
