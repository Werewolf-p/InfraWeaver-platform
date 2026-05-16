"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface PageShellProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumb?: BreadcrumbItem[];
  children: ReactNode;
  className?: string;
}

export function PageShell({ title, subtitle, actions, breadcrumb, children, className }: PageShellProps) {
  const [sticky, setSticky] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrollContainer = document.getElementById("dashboard-main");
    if (!scrollContainer) return;

    const handleScroll = () => setSticky(scrollContainer.scrollTop > 12);
    handleScroll();
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div ref={shellRef} className={cn("space-y-6", className)}>
      <div
        className={cn(
          "sticky top-0 z-20 -mx-4 -mt-4 mb-6 border-b px-4 py-4 backdrop-blur transition-all sm:-mx-4 md:-mx-6 md:px-6",
          sticky
            ? "border-[rgb(var(--color-border))] bg-[rgba(var(--color-surface-base),0.92)] shadow-sm"
            : "border-transparent bg-transparent",
        )}
      >
        {breadcrumb?.length ? (
          <nav className="mb-3 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-[rgb(var(--color-text-secondary))] scrollbar-none">
            {breadcrumb.map((item, index) => (
              <span key={`${item.label}-${index}`} className="flex items-center gap-1">
                {index > 0 ? <ChevronRight className="h-3 w-3 text-[rgb(var(--color-text-tertiary))]" /> : null}
                {item.href ? (
                  <Link href={item.href} className="transition-colors hover:text-[rgb(var(--color-text-primary))]">
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-[rgb(var(--color-text-primary))]">{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-[rgb(var(--color-text-primary))] sm:text-3xl">{title}</h1>
            {subtitle ? (
              <p className="mt-2 max-w-3xl text-sm text-[rgb(var(--color-text-secondary))] sm:text-base">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      {children}
    </div>
  );
}
