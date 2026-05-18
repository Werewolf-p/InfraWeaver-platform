"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Compass, Gamepad2, Loader2, Package, Search as SearchIcon, Settings2, Star, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFavorites } from "@/hooks/use-favorites";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useRecentSearches } from "@/hooks/use-recent-searches";
import { ALL_NAV_ITEMS } from "@/lib/nav-config";
import {
  EMPTY_SEARCH_RESPONSE,
  SEARCH_CATEGORY_LABELS,
  type SearchResponse,
  type SearchResult,
} from "@/lib/search";
import { cn } from "@/lib/utils";

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CATEGORY_ORDER: Array<keyof SearchResponse> = [
  "navigation",
  "gameServers",
  "pods",
  "apps",
  "settings",
];

const CATEGORY_ICONS = {
  navigation: Compass,
  "game-server": Gamepad2,
  pod: Compass,
  app: Package,
  setting: Settings2,
};

interface DisplaySection {
  key: string;
  label: string;
  icon: React.ElementType;
  entries: SearchResult[];
}

function normalizeCategory(key: keyof SearchResponse): SearchResult["category"] {
  if (key === "gameServers") return "game-server";
  if (key === "pods") return "pod";
  if (key === "apps") return "app";
  if (key === "settings") return "setting";
  return "navigation";
}

function scoreResult(
  result: SearchResult,
  query: string,
  favoriteHrefs: Set<string>,
  recentPageVisits: Map<string, number>,
) {
  const value = query.trim().toLowerCase();
  if (!value) return 0;

  const title = result.title.toLowerCase();
  const subtitle = result.subtitle?.toLowerCase() ?? "";
  const href = result.href.toLowerCase();
  const badge = result.badge?.toLowerCase() ?? "";

  let score = 0;
  if (title === value) score += 160;
  if (href === value || href.endsWith(`/${value}`)) score += 120;
  if (title.startsWith(value)) score += 90;
  if (title.includes(value)) score += 60;
  if (subtitle.startsWith(value)) score += 30;
  if (subtitle.includes(value)) score += 18;
  if (badge === value) score += 12;
  if (favoriteHrefs.has(result.href)) score += 28;
  const lastVisited = recentPageVisits.get(result.href);
  if (lastVisited) {
    const ageHours = Math.floor((Date.now() - lastVisited) / 3_600_000);
    score += Math.max(6, 24 - ageHours);
  }
  if (result.category === "navigation") score += 6;
  return score;
}

function quickAccessResults(
  favoriteHrefs: Set<string>,
  recentPages: Array<{ href: string; title: string; visitedAt: number }>,
) {
  const navMap = new Map(ALL_NAV_ITEMS.map((item) => [item.href, item]));
  const seen = new Set<string>();
  const entries: SearchResult[] = [];

  for (const href of favoriteHrefs) {
    const item = navMap.get(href);
    if (!item || seen.has(href)) continue;
    seen.add(href);
    entries.push({
      id: `quick-favorite-${href}`,
      title: item.label,
      subtitle: item.description ?? "Pinned page",
      href,
      category: "navigation",
      icon: "★",
      badge: "Pinned",
      badgeColor: "bg-yellow-500/10 text-yellow-200",
    });
  }

  for (const page of recentPages) {
    if (seen.has(page.href)) continue;
    seen.add(page.href);
    const item = navMap.get(page.href);
    entries.push({
      id: `quick-recent-${page.href}`,
      title: item?.label ?? page.title,
      subtitle: item?.description ?? `Visited ${new Date(page.visitedAt).toLocaleString()}`,
      href: page.href,
      category: "navigation",
      icon: "🕘",
      badge: "Recent",
      badgeColor: "bg-sky-500/10 text-sky-200",
    });
  }

  return entries.slice(0, 8);
}

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse>(EMPTY_SEARCH_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const { favorites } = useFavorites();
  const { recentPages } = useRecentPages();
  const { recentSearches, addRecentSearch, clearRecentSearches } = useRecentSearches();

  const favoriteHrefs = useMemo(() => new Set(favorites.map((favorite) => favorite.href)), [favorites]);
  const recentPageVisits = useMemo(
    () => new Map(recentPages.map((page) => [page.href, page.visitedAt])),
    [recentPages],
  );

  useEffect(() => {
    if (!open) return;

    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Search failed");
        const data = (await res.json()) as SearchResponse;
        setResults(data);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setResults(EMPTY_SEARCH_RESPONSE);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 160);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const sections = useMemo<DisplaySection[]>(() => {
    if (!query.trim()) {
      const quickEntries = quickAccessResults(favoriteHrefs, recentPages);
      return quickEntries.length > 0
        ? [{ key: "quick-access", label: "Quick access", icon: Star, entries: quickEntries }]
        : [];
    }

    return CATEGORY_ORDER
      .map((key) => {
        const category = normalizeCategory(key);
        const entries = [...results[key]].sort((left, right) => {
          const scoreDifference = scoreResult(right, query, favoriteHrefs, recentPageVisits) - scoreResult(left, query, favoriteHrefs, recentPageVisits);
          if (scoreDifference !== 0) return scoreDifference;
          return left.title.localeCompare(right.title);
        });
        return {
          key,
          label: SEARCH_CATEGORY_LABELS[category],
          icon: CATEGORY_ICONS[category],
          entries,
        } satisfies DisplaySection;
      })
      .filter((section) => section.entries.length > 0);
  }, [favoriteHrefs, query, recentPageVisits, recentPages, results]);

  const flatResults = useMemo(
    () => sections.flatMap((section) => section.entries),
    [sections],
  );

  useEffect(() => {
    if (!open || flatResults.length === 0) return;
    const active = flatResults[activeIndex];
    if (!active) return;
    optionRefs.current[active.id]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flatResults, open]);

  const handleSelect = (result: SearchResult) => {
    if (query.trim()) {
      addRecentSearch(query);
    }
    router.push(result.href);
    handleOpenChange(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setResults(EMPTY_SEARCH_RESPONSE);
      setLoading(false);
      setActiveIndex(0);
    }
    onOpenChange(nextOpen);
  };

  const activeResult = flatResults[activeIndex];

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[500] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-[501] overflow-hidden bg-white dark:bg-[#111] p-0 shadow-2xl outline-none sm:inset-x-auto sm:left-1/2 sm:top-[14vh] sm:w-[min(92vw,42rem)] sm:-translate-x-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a]">
          <Dialog.Title className="sr-only">Global search</Dialog.Title>
          <div className="flex items-center border-b border-gray-200 dark:border-[#2a2a2a] px-4 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] sm:pt-0">
            <SearchIcon className="mr-2 h-4 w-4 shrink-0 text-gray-400 dark:text-[#666]" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={open}
              aria-controls="infraweaver-global-search-results"
              aria-activedescendant={activeResult ? `infraweaver-search-option-${activeResult.id}` : undefined}
              className="flex-1 bg-transparent py-3.5 text-base text-gray-900 dark:text-[#f2f2f2] outline-none placeholder:text-gray-400 dark:placeholder:text-[#444] sm:text-sm"
              placeholder="Search pods, servers, apps, and pages..."
              value={query}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setQuery(nextQuery);
                setActiveIndex(0);
                if (!nextQuery.trim()) {
                  setLoading(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.min(current + 1, Math.max(flatResults.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (flatResults[activeIndex]) {
                    handleSelect(flatResults[activeIndex]);
                  }
                }
              }}
            />
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin text-gray-400 dark:text-[#666]" /> : null}
            <kbd className="hidden rounded border border-gray-200 dark:border-[#333] px-1 text-xs text-gray-400 dark:text-[#444] sm:inline-flex">↑↓ ↵ ESC</kbd>
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="ml-1 inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 dark:text-[#666] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] sm:hidden"
              aria-label="Close search"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div
            id="infraweaver-global-search-results"
            ref={listRef}
            role="listbox"
            className="max-h-[calc(100dvh-5rem)] overflow-y-auto py-2 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:max-h-[28rem] sm:pb-2"
          >
            {!query.trim() && recentSearches.length > 0 ? (
              <div className="px-4 pb-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-[#888]">Recent searches</p>
                  <button
                    type="button"
                    onClick={clearRecentSearches}
                    className="text-[11px] text-gray-400 dark:text-[#666] transition-colors hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                  >
                    Clear
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {recentSearches.map((entry) => (
                    <button
                      key={entry.query}
                      type="button"
                      onClick={() => setQuery(entry.query)}
                      className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-3 py-1.5 text-xs text-gray-700 dark:text-[#d4d4d4] transition-colors hover:border-[#3b82f6]/40 hover:text-gray-900 dark:hover:text-white"
                    >
                      {entry.query}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {loading ? (
              <div className="space-y-2 px-4 py-3">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="h-14 animate-pulse rounded-xl border border-[#202020] bg-gray-50 dark:bg-[#161616]" />
                ))}
              </div>
            ) : null}

            {!loading && sections.map((section) => {
              const SectionIcon = section.icon;
              return (
                <div key={section.key}>
                  <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-[#888]">
                    <SectionIcon className="h-3.5 w-3.5" />
                    {section.label}
                  </div>
                  {section.entries.map((result) => {
                    const index = flatResults.findIndex((entry) => entry.id === result.id);
                    const isActive = index === activeIndex;
                    return (
                      <button
                        key={result.id}
                        id={`infraweaver-search-option-${result.id}`}
                        ref={(node) => {
                          optionRefs.current[result.id] = node;
                        }}
                        role="option"
                        aria-selected={isActive}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors focus:outline-none",
                          isActive ? "bg-white dark:bg-[#1a1a1a]" : "hover:bg-[#171717]"
                        )}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => handleSelect(result)}
                      >
                        <span className="text-base text-gray-700 dark:text-[#d4d4d4]">{result.icon ?? "•"}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-gray-900 dark:text-[#f2f2f2]">{result.title}</div>
                          {result.subtitle ? (
                            <div className="truncate text-xs text-gray-500 dark:text-[#888]">{result.subtitle}</div>
                          ) : null}
                        </div>
                        {result.badge ? (
                          <span className={`rounded-full px-1.5 py-0.5 text-xs ${result.badgeColor ?? "bg-gray-50 dark:bg-[#1f1f1f] text-gray-500 dark:text-[#888]"}`}>
                            {result.badge}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {query.length > 0 && flatResults.length === 0 && !loading ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-[#888]">No results for &quot;{query}&quot;</div>
            ) : null}
            {!query.trim() && !loading && sections.length === 0 && recentSearches.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-[#888]">Pinned pages and recent searches will show up here.</div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
