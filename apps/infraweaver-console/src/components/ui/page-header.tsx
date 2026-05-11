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
    <div className="pb-4 mb-6 border-b border-[#2a2a2a] flex-shrink-0">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav className="flex items-center gap-1 mb-2 text-xs text-[#666]">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3 h-3" />}
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-[#9e9e9e] transition-colors">{crumb.label}</Link>
              ) : (
                <span className="text-[#9e9e9e]">{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="flex items-center gap-3">
        {Icon && <Icon className="w-6 h-6 text-[#0078D4] flex-shrink-0" />}
        <h1 className="text-xl font-semibold text-[#f2f2f2]">{title}</h1>
        {badge && (
          <span className="px-2 py-0.5 rounded text-xs bg-[#2a2a2a] text-[#9e9e9e] border border-[#333] font-mono">
            {badge}
          </span>
        )}
        <div className="flex-1" />
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {subtitle && <p className="mt-1 text-sm text-[#9e9e9e]">{subtitle}</p>}
    </div>
  );
}
