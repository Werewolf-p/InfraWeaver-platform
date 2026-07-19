"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export type SiteTab = "overview" | "manage" | "connector";

const TABS: { id: SiteTab; label: string; path: (site: string) => string }[] = [
  { id: "overview", label: "Overview", path: (site) => `/wordpress/${site}` },
  { id: "manage", label: "Manage", path: (site) => `/wordpress/${site}/manage` },
  { id: "connector", label: "InfraWeaver Connector", path: (site) => `/wordpress/${site}/connector` },
];

/** Tab bar for the per-site management pages. */
export function SiteTabs({ site, active }: { site: string; active: SiteTab }) {
  return (
    <nav aria-label="Site sections" className="mt-6 flex gap-1 border-b border-zinc-800">
      {TABS.map((tab) => {
        const on = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.path(site)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3.5 py-2 text-sm transition-colors",
              on
                ? "border-sky-400 font-medium text-zinc-100"
                : "border-transparent text-zinc-400 hover:border-zinc-600 hover:text-zinc-200",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
