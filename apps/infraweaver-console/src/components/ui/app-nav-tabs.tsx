"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LayoutGrid, Package, Store } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/apps", label: "All Installed", icon: LayoutGrid, tab: null },
  { href: "/apps?tab=catalog", label: "App Catalog", icon: Package, tab: "catalog" },
  { href: "/apps?tab=community", label: "Community Store", icon: Store, tab: "community" },
] as const;

export function AppNavTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams?.get("tab");

  const isActive = (itemTab: string | null) => {
    if (pathname !== "/apps") return false;
    if (itemTab === null) return !tab || tab === "installed";
    return tab === itemTab;
  };

  return (
    <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl mb-6 overflow-x-auto">
      {TABS.map((t) => {
        const active = isActive(t.tab);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap min-w-fit",
              active
                ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                : "text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5"
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
