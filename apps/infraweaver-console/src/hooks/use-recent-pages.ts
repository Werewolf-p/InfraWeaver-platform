"use client";

import { useCallback } from "react";
import { useServerPreferences } from "@/hooks/use-server-preferences";
import { MAX_RECENTLY_VISITED, type RecentlyVisitedPage } from "@/lib/user-preferences";

export type RecentPage = RecentlyVisitedPage;

export function useRecentPages() {
  const { preferences, setPreferences } = useServerPreferences();
  const recentPages = preferences.recentlyVisited;

  const addRecentPage = useCallback((href: string, title: string) => {
    setPreferences((current) => {
      const filtered = current.recentlyVisited.filter((page) => page.href !== href);
      return {
        recentlyVisited: [{ href, title, visitedAt: Date.now() }, ...filtered].slice(0, MAX_RECENTLY_VISITED),
      };
    });
  }, [setPreferences]);

  return { recentPages, addRecentPage };
}
