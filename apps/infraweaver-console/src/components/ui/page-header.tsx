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
  sticky?: boolean;
}

export function PageHeader({ icon: Icon, title, actions, badge, breadcrumb }: PageHeaderProps) {
  return (
    <div className="mb-4 sm:mb-5">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav className="mb-1.5 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[11px] text-slate-500 scrollbar-none sm:text-xs dark:text-[#888]">
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon ? <Icon className="h-5 w-5 shrink-0 text-sky-600 dark:text-[#3b82f6]" /> : null}
          <h1 className="truncate text-lg font-semibold text-slate-950 sm:text-xl dark:text-[#f2f2f2]">{title}</h1>
          {badge ? (
            <span className={cn("rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-500 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#888]")}>{badge}</span>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
