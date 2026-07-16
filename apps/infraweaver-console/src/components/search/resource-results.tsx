"use client";

import Link from "next/link";
import { Box, Gamepad2, Loader2, Server } from "lucide-react";
import type { ElementType } from "react";
import { useResourceSearch, type SearchResult } from "@/hooks/use-resource-search";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<SearchResult["type"], ElementType> = {
  pod: Server,
  app: Box,
  "game-server": Gamepad2,
  nav: Server,
};

const TYPE_LABEL: Record<string, string> = {
  pod: "Pods",
  app: "Apps",
  "game-server": "Game Servers",
};

/**
 * Live, RBAC-filtered resource results (pods, apps, game servers) for the inline
 * search bars. Shares one hook/endpoint with the ⌘K palette and Quick-search
 * modal, so every search surface stays consistent. Renders nothing until there
 * is a query and at least one match.
 */
export function ResourceResults({
  query,
  onNavigate,
  className,
}: {
  query: string;
  onNavigate?: () => void;
  className?: string;
}) {
  const { results, loading } = useResourceSearch(query);

  if (!query.trim()) return null;
  if (results.length === 0) {
    return loading ? (
      <div className={cn("flex items-center gap-2 px-3 py-2 text-xs text-gray-400 dark:text-[#8a8a8a]", className)}>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Searching resources…
      </div>
    ) : null;
  }

  const order: Array<SearchResult["type"]> = ["pod", "app", "game-server"];
  const groups = order
    .map((type) => ({ type, items: results.filter((result) => result.type === type) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className={className}>
      {groups.map((group) => (
        <div key={group.type} className="mb-2">
          <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-[#8a8a8a]">
            {TYPE_LABEL[group.type] ?? group.type}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = TYPE_ICON[item.type] ?? Server;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={onNavigate}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-[#2a2a2a] dark:hover:text-[#f2f2f2]"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-[#9a9a9a]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.subtitle && (
                    <span className="ml-1 flex-shrink-0 truncate text-[10px] text-gray-400 dark:text-[#8a8a8a]">
                      {item.subtitle}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
