"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
import { cn } from "@/lib/utils";

const ROUTE_LABELS: Record<string, string> = {
  apps: "Apps",
  cluster: "Cluster",
  logs: "Logs",
  settings: "Settings",
  changelog: "What's New",
  security: "Security",
  storage: "Storage",
  network: "Network",
  registry: "Registry",
};

export function Breadcrumb({ className }: { className?: string }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs = segments.map((seg, i) => ({
    label: ROUTE_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1),
    href: "/" + segments.slice(0, i + 1).join("/"),
    isLast: i === segments.length - 1,
  }));

  return (
    <nav aria-label="Breadcrumb" className={cn("flex items-center gap-1.5 px-4 py-2 text-xs text-white/40", className)}>
      <Link href="/" className="flex items-center hover:text-white/70 transition-colors">
        <Home className="w-3 h-3" />
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3 opacity-30" />
          {crumb.isLast ? (
            <span className="text-white/70 font-medium">{crumb.label}</span>
          ) : (
            <Link href={crumb.href} className="hover:text-white/70 transition-colors">{crumb.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}
