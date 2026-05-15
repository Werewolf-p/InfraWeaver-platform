"use client";

import React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  icon?: React.ElementType;
  title: string;
  subtitle?: string;
  description?: string;
  actions?: React.ReactNode;
  badge?: string;
  breadcrumb?: BreadcrumbItem[];
}

export function PageHeader({ icon: Icon, title, subtitle, description, actions, badge, breadcrumb }: PageHeaderProps) {
  const supportingText = description ?? subtitle;

  return (
    <div className="mb-4 flex-shrink-0 rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur sm:mb-6 sm:p-5 dark:border-[#2a2a2a] dark:bg-[#111]/95">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav className="mb-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[11px] text-slate-500 scrollbar-none sm:text-xs dark:text-[#888]">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <ChevronRight className="h-3 w-3" /> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="transition-colors hover:text-slate-700 dark:hover:text-[#d4d4d4]">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-slate-700 dark:text-[#d4d4d4]">{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            {Icon ? <Icon className="h-5 w-5 shrink-0 text-sky-600 sm:h-6 sm:w-6 dark:text-[#3b82f6]" /> : null}
            <h1 className="truncate text-xl font-semibold text-slate-950 sm:text-2xl dark:text-[#f2f2f2]">{title}</h1>
            {badge ? (
              <span className={cn("rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-500 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#888]")}>{badge}</span>
            ) : null}
          </div>
          {supportingText ? <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-[#d4d4d4]">{supportingText}</p> : null}
        </div>
        {actions ? <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">{actions}</div> : null}
      </div>
    </div>
  );
}
