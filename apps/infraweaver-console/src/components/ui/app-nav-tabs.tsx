"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Box, PlusCircle, Store, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/apps", label: "Deployed Apps", icon: Box, exact: true },
  { href: "/catalog-install", label: "App Catalog", icon: PlusCircle, exact: false },
  { href: "/community-apps", label: "Community Store", icon: Store, exact: false },
  { href: "/community-apps?tab=installed", label: "Installed", icon: CheckCircle2, exact: false, searchParam: { tab: "installed" } },
] as const;

export function AppNavTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams?.get("tab");

  const isActive = (href: string, exact: boolean, searchParam?: { tab: string }) => {
    const [path] = href.split("?");
    if (searchParam) {
      return pathname === path && tab === searchParam.tab;
    }
    if (exact) return pathname === path;
    // For community-apps without tab param, only match when tab is not "installed"
    if (path === "/community-apps") return pathname === path && tab !== "installed";
    return pathname === path;
  };

  return (
    <div className="flex items-center gap-1 p-1 bg-slate-900/60 border border-white/10 rounded-xl mb-6 overflow-x-auto">
      {TABS.map((t) => {
        const active = isActive(
          t.href,
          t.exact,
          "searchParam" in t ? t.searchParam : undefined
        );
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap min-w-fit",
              active
                ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                : "text-slate-400 hover:text-white hover:bg-white/5"
            )}
          >
            <t.icon className="w-4 h-4 flex-shrink-0" />
            <span>{t.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
