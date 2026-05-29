"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
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

const STORAGE_KEY = "page-header-collapsed";

export function PageHeader({ icon: Icon, title, subtitle, description, actions, badge, breadcrumb, sticky = true }: PageHeaderProps) {
  const supportingText = description ?? subtitle;
  const [collapsed, setCollapsed] = useState(false);

  // Read persisted preference on mount (avoids SSR mismatch)
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(STORAGE_KEY) === "1"); } catch {}
  }, []);

  function toggleCollapse() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch {}
  }

  return (
    <div className={cn(
      "mb-4 flex-shrink-0 rounded-3xl border border-slate-200 bg-white/95 shadow-sm backdrop-blur sm:mb-6",
      collapsed ? "p-3 sm:p-3.5" : "p-4 sm:p-5",
      "dark:border-[#2a2a2a] dark:bg-[#111]/90",
      sticky && "sticky top-0 z-20 backdrop-blur-md",
    )}>
      {!collapsed && breadcrumb && breadcrumb.length > 0 ? (
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
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            {Icon ? <Icon className="h-5 w-5 shrink-0 text-sky-600 sm:h-6 sm:w-6 dark:text-[#3b82f6]" /> : null}
            <h1 className="truncate text-xl font-semibold text-slate-950 sm:text-2xl dark:text-[#f2f2f2]">{title}</h1>
            {badge ? (
              <span className={cn("rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-500 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#888]")}>{badge}</span>
            ) : null}
          </div>
          {!collapsed && supportingText ? <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-[#d4d4d4]">{supportingText}</p> : null}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
          {actions}
          {/* Collapse toggle — only shown when there is a subtitle to hide */}
          {supportingText ? (
            <button
              type="button"
              onClick={toggleCollapse}
              title={collapsed ? "Show description" : "Hide description"}
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-600 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#555] dark:hover:border-[#3a3a3a] dark:hover:text-[#999] xl:ml-0"
            >
              {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
