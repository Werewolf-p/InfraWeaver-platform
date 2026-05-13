"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Home } from "lucide-react";
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
  registry: "Registry",
  certificates: "Certificates",
  gameservers: "Port Routing",
  "game-hub": "Game Hub",
  "all-services": "All Services",
  "network-policies": "Network Policies",
  "secret-expiry": "Secret Expiry",
};

function labelForSegment(segment: string) {
  return ROUTE_LABELS[segment] ?? decodeURIComponent(segment);
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
  const crumbs = breadcrumbItems(pathname);

  if (crumbs.length === 0) return null;

  return (
    <div className={cn("flex items-center gap-2 border-b border-[#2a2a2a] bg-[#111]/95 px-4 py-2 text-xs text-[#888]", className)}>
      {crumbs.length > 1 ? (
        <button
          onClick={() => router.back()}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]"
          title="Go back"
          aria-label="Go back"
        >
          <ChevronLeft className="h-3 w-3" />
          Back
        </button>
      ) : null}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none">
        <Link href="/" className="flex items-center rounded-md p-1 transition-colors hover:text-[#f2f2f2]">
          <Home className="h-3 w-3" />
        </Link>
        {crumbs.map((crumb) => (
          <span key={crumb.href} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 opacity-50" />
            {crumb.isLast ? (
              <span className="font-medium text-[#d4d4d4]">{crumb.label}</span>
            ) : (
              <Link href={crumb.href} className="transition-colors hover:text-[#f2f2f2]">{crumb.label}</Link>
            )}
          </span>
        ))}
      </nav>
    </div>
  );
}
