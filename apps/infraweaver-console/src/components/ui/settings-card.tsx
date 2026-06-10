import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsCardProps {
  title: string;
  description: string;
  icon?: ElementType;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SettingsCard({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
  contentClassName,
}: SettingsCardProps) {
  return (
    <section className={cn("rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 sm:p-5", className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {Icon ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--az-primary-muted)]">
              <Icon className="h-4 w-4 text-[var(--az-primary)]" />
            </div>
          ) : null}
          <div>
            <p className="text-base font-medium text-gray-900 dark:text-white sm:text-sm">{title}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 sm:text-xs">{description}</p>
          </div>
        </div>
        {action ? <div className="sm:shrink-0">{action}</div> : null}
      </div>
      {children ? <div className={cn("mt-4", contentClassName)}>{children}</div> : null}
    </section>
  );
}
