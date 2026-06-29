"use client";
import { useState, useEffect } from "react";
import type { SearchResponse } from "@/lib/search";

export interface SearchResult {
  id: string;
  type: "app" | "pod" | "game-server" | "nav";
  name: string;
  subtitle: string;
  href: string;
  icon?: string;
}

type ApiItem = SearchResponse["pods"][number];

/**
 * Live resource search for the inline search bars (sidebar filter, mobile
 * drawer/more sheet) and the spotlight. Backed by /api/search, which is already
 * RBAC-filtered server-side — it only returns the pods/apps/game-servers the
 * session may see, and each result deep-links to its detail panel
 * (pod → pod+firewall view, game server → game panel). Debounced.
 */
export function useResourceSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with an external/browser store or dependency-driven reset; not derived render state
      setResults([]);
      return;
    }

    setLoading(true);
    const controller = new AbortController();

    const fetchAll = async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setResults([]);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as SearchResponse;
        const map = (items: ApiItem[], type: SearchResult["type"]): SearchResult[] =>
          items.map((item) => ({
            id: item.id,
            type,
            name: item.title,
            subtitle: item.subtitle ?? "",
            href: item.href,
            icon: item.icon,
          }));
        const out = [
          ...map(data.pods ?? [], "pod"),
          ...map(data.apps ?? [], "app"),
          ...map(data.gameServers ?? [], "game-server"),
        ];
        setResults(out.slice(0, 24));
      } catch {
        // ignore (aborted or network) — leave previous results
      }
      setLoading(false);
    };

    const timer = setTimeout(() => void fetchAll(), 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return { results, loading };
}
