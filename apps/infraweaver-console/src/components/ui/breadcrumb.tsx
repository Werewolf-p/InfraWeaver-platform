"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, Home, Sparkles } from "lucide-react";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { NAV_GROUPS } from "@/lib/nav-config";
import { cn } from "@/lib/utils";

export const ROUTE_LABELS: Record<string, string> = {
  home: "Home",
  apps: "Apps",
  cluster: "Cluster",
  dns: "DNS",
  logs: "Logs",
  settings: "Settings",
  changelog: "What's New",
  security: "Security",
  storage: "Storage",
  network: "Network",
  ingress: "Ingress",
  registry: "Registry",
  certificates: "Certificates",
  gameservers: "Port Routing",
  "game-hub": "Game Hub",
  wiki: "Wiki",
  "user-manual": "User Manual",
  "developer-guide": "Developer Guide",
  "getting-started": "Getting Started",
  "dns-management": "DNS Management",
  "rbac-access-control": "RBAC & Access Control",
  "community-apps": "Community Apps",
  monitoring: "Monitoring",
  "files-and-storage": "Files & Storage",
  "mobile-usage": "Mobile Usage",
  architecture: "Architecture",
  "api-reference": "API Reference",
  deployment: "Deployment",
  "kubernetes-manifests": "Kubernetes Manifests",
  "adding-features": "Adding Features",
  troubleshooting: "Troubleshooting",
  "game-eggs": "Game Eggs",
  "all-services": "All Services",
  "network-policies": "Network Policies",
  "secret-expiry": "Secret Expiry",
  automations: "Automation Hub",
};

function labelForSegment(segment: string) {
  return ROUTE_LABELS[segment] ?? decodeURIComponent(segment);
}

function matchesPath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function titleForPathname(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "Dashboard";
  return labelForSegment(segments[segments.length - 1] ?? "Dashboard");
}

function breadcrumbItems(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.map((segment, index) => ({
    label: labelForSegment(segment),
    href: `/${segments.slice(0, index + 1).join("/")}`,
    isLast: index === segments.length - 1,
  }));
}

export function Breadcrumb({ className }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const { recentPages } = useRecentPages();
  const [jumpOpen, setJumpOpen] = useState(false);
  const jumpRef = useRef<HTMLDivElement>(null);
  const crumbs = breadcrumbItems(pathname);

  const jumpItems = useMemo(() => {
    const currentGroup = NAV_GROUPS.find((group) => group.items.some((item) => matchesPath(pathname, item.href)));
    const items = [
      ...(currentGroup?.items.map((item) => ({ href: item.href, label: item.label, subtitle: currentGroup.label })) ?? []),
      ...recentPages.map((page) => ({ href: page.href, label: page.title, subtitle: "Recent" })),
    ];

    const seen = new Set<string>();
    return items.filter((item) => {
      if (matchesPath(pathname, item.href)) return false;
      if (seen.has(item.href)) return false;
      seen.add(item.href);
      return true;
    }).slice(0, 8);
  }, [pathname, recentPages]);

  useEffect(() => {
    if (!jumpOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!jumpRef.current?.contains(event.target as Node)) {
        setJumpOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setJumpOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [jumpOpen]);

  if (crumbs.length === 0) return null;

  return (
    <div className={cn("flex items-center gap-2 border-b border-gray-200 dark:border-[#2a2a2a] bg-white/90 dark:bg-[#111]/95 backdrop-blur-sm px-4 py-2 text-xs text-gray-600 dark:text-[#888]", className)}>
      {crumbs.length > 1 ? (
        <button
          onClick={() => router.back()}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]"
          title="Go back"
          aria-label="Go back"
        >
          <ChevronLeft className="h-3 w-3" />
          Back
        </button>
      ) : null}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none">
        <Link href="/" className="flex items-center rounded-md p-1 transition-colors hover:text-gray-900 dark:hover:text-[#f2f2f2]">
          <Home className="h-3 w-3" />
        </Link>
        {crumbs.map((crumb) => (
          <span key={crumb.href} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 opacity-50" />
            {crumb.isLast ? (
              <span className="font-medium text-gray-700 dark:text-[#d4d4d4]">{crumb.label}</span>
            ) : (
              <Link href={crumb.href} className="transition-colors hover:text-gray-900 dark:hover:text-[#f2f2f2]">{crumb.label}</Link>
            )}
          </span>
        ))}
      </nav>
      {jumpItems.length > 0 ? (
        <div className="relative ml-auto" ref={jumpRef}>
          <button
            type="button"
            onClick={() => setJumpOpen((open) => !open)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
            aria-haspopup="menu"
            aria-expanded={jumpOpen}
          >
            <Sparkles className="h-3 w-3" />
            Jump
            <ChevronDown className={cn("h-3 w-3 transition-transform", jumpOpen && "rotate-180")} />
          </button>
          {jumpOpen ? (
            <div className="absolute right-0 top-full z-20 mt-2 min-w-[14rem] overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] shadow-2xl">
              <div className="border-b border-gray-200 dark:border-[#2a2a2a] px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-[#888]">Quick jump</p>
                <p className="mt-1 text-[11px] text-gray-400 dark:text-[#666]">Sibling pages and recent destinations.</p>
              </div>
              <div className="py-1">
                {jumpItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-gray-900 dark:text-[#f2f2f2]">{item.label}</p>
                      <p className="truncate text-[11px] text-gray-400 dark:text-[#666]">{item.subtitle}</p>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-[#555]" />
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
