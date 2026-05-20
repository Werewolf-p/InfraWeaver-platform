"use client";

import { useCallback } from "react";
import { useServerPreferences } from "@/hooks/use-server-preferences";
import { MAX_RECENT_SEARCHES, type RecentSearchEntry } from "@/lib/user-preferences";

export type RecentSearch = RecentSearchEntry;

export function useRecentSearches() {
  const { preferences, setPreferences } = useServerPreferences();
  const recentSearches = preferences.recentSearches;

  const addRecentSearch = useCallback((query: string) => {
    const value = query.trim();
    if (!value) return;

    setPreferences((current) => {
      const filtered = current.recentSearches.filter((entry) => entry.query.toLowerCase() !== value.toLowerCase());
      return {
        recentSearches: [{ query: value, usedAt: Date.now() }, ...filtered].slice(0, MAX_RECENT_SEARCHES),
      };
    });
  }, [setPreferences]);

  const clearRecentSearches = useCallback(() => {
    setPreferences({ recentSearches: [] });
  }, [setPreferences]);

  return { recentSearches, addRecentSearch, clearRecentSearches };
}
