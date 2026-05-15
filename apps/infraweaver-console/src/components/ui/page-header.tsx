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
}

export function PageHeader({ icon: Icon, title, subtitle, description, actions, badge, breadcrumb }: PageHeaderProps) {
  const supportingText = description ?? subtitle;

  return (
    <div className="mb-4 flex-shrink-0 border-b border-[#2a2a2a] pb-3 sm:mb-6 sm:pb-4">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav className="mb-1.5 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[11px] text-[#888] scrollbar-none sm:mb-2 sm:text-xs">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <ChevronRight className="h-3 w-3" /> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="transition-colors hover:text-[#d4d4d4]">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-[#d4d4d4]">{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          {Icon ? <Icon className="h-5 w-5 shrink-0 text-[#3b82f6] sm:h-6 sm:w-6" /> : null}
          <h1 className="truncate text-lg font-semibold text-[#f2f2f2] sm:text-xl">{title}</h1>
          {badge ? (
            <span className="rounded-full border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-0.5 font-mono text-xs text-[#888]">
              {badge}
            </span>
          ) : null}
        </div>
        <div className="flex-1" />
        {actions ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{actions}</div> : null}
      </div>
      {supportingText ? <p className="mt-1 text-xs text-[#d4d4d4] sm:text-sm">{supportingText}</p> : null}
    </div>
  );
}
