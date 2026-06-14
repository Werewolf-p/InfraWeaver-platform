"use client";

import React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

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
    <div className="mb-5 sm:mb-6">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav
          aria-label="Breadcrumb"
          className="mb-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[11px] text-slate-400 scrollbar-none sm:text-xs dark:text-[#666]"
        >
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-50" /> : null}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="rounded transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--az-primary)] dark:hover:text-[#d4d4d4]"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="font-medium text-slate-600 dark:text-[#bbb]">{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {Icon ? (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--az-primary-muted)] text-[var(--az-primary)]">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-[#f2f2f2]">
              {title}
            </h1>
          </div>
          {badge ? (
            <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 font-mono text-[11px] text-slate-500 dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#888]">
              {badge}
            </span>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {/* Subtle separator below header */}
      <div className="mt-4 h-px bg-gradient-to-r from-slate-200 via-slate-100 to-transparent dark:from-[#2a2a2a] dark:via-[#1e1e1e] dark:to-transparent" />
    </div>
  );
}
