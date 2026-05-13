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
  actions?: React.ReactNode;
  badge?: string;
  breadcrumb?: BreadcrumbItem[];
}

export function PageHeader({ icon: Icon, title, subtitle, actions, badge, breadcrumb }: PageHeaderProps) {
  return (
    <div className="mb-6 flex-shrink-0 border-b border-[#2a2a2a] pb-4">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav className="mb-2 flex items-center gap-1 text-xs text-[#888]">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <ChevronRight className="h-3 w-3" /> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="transition-colors hover:text-[#d4d4d4]">{crumb.label}</Link>
              ) : (
                <span className="text-[#d4d4d4]">{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {Icon ? <Icon className="h-6 w-6 shrink-0 text-[#3b82f6]" /> : null}
        <h1 className="text-xl font-semibold text-[#f2f2f2]">{title}</h1>
        {badge ? (
          <span className="rounded-full border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-0.5 font-mono text-xs text-[#888]">
            {badge}
          </span>
        ) : null}
        <div className="flex-1" />
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="mt-1 text-sm text-[#d4d4d4]">{subtitle}</p> : null}
    </div>
  );
}
