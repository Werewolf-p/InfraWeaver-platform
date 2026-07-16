"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  Bell, Command, Compass, FileText, Gamepad2, Globe, HardDrive, Keyboard,
  Layers, Loader2, LogOut, Monitor, Moon, Package, Pin, PinOff, Plus,
  RefreshCw, Rows3, Search as SearchIcon, Settings2, Shield, Star, Sun,
  Upload, UserPlus, Wand2, X, Zap,
} from "lucide-react";
import { signOut } from "next-auth/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFavorites, type Favorite } from "@/hooks/use-favorites";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useRecentSearches } from "@/hooks/use-recent-searches";
import { useRBAC } from "@/hooks/use-rbac";
import { useTheme } from "@/hooks/use-theme";
import { useSettingsContext, type Density } from "@/contexts/settings-context";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { OPEN_KEYBOARD_SHORTCUTS_EVENT } from "@/components/ui/keyboard-shortcuts-modal";
import { SkeletonRow } from "@/components/ui/skeleton-row";
import { ALL_NAV_ITEMS } from "@/lib/nav-config";
import { toast } from "@/lib/notify";
import {
  EMPTY_SEARCH_RESPONSE,
  SEARCH_CATEGORY_LABELS,
  type SearchResponse,
  type SearchResult,
} from "@/lib/search";
import { cn } from "@/lib/utils";
import { fuzzyMatch, splitHighlight } from "./fuzzy";

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

const DENSITY_ORDER: Density[] = ["compact", "comfortable", "spacious"];
const THEME_ORDER = ["light", "dark", "system"] as const;

interface PaletteEntry {
  id: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  badge?: string;
  badgeColor?: string;
  matchIndices?: number[];
  favoriteHref?: string;
  run: () => void;
}

interface DisplaySection {
  key: string;
  label: string;
  icon: React.ElementType;
  entries: PaletteEntry[];
}

interface CommandAction {
  id: string;
  title: string;
  subtitle?: string;
  icon: React.ElementType;
  keywords?: string;
  run: () => void;
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

function HighlightedTitle({ title, indices }: { title: string; indices?: number[] }) {
  const segments = splitHighlight(title, indices);
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="bg-transparent font-semibold text-[#3b82f6] dark:text-[#7cb1ff]">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse>(EMPTY_SEARCH_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const { favorites, toggleFavorite, isFavorite } = useFavorites();
  const { recentPages } = useRecentPages();
  const { recentSearches, addRecentSearch, clearRecentSearches } = useRecentSearches();
  const { theme, setTheme } = useTheme();
  const { settings, updateSetting } = useSettingsContext();
  const { simpleMode, toggle: toggleSimpleMode } = useSimpleMode();
  const { can } = useRBAC();

  const favoriteHrefs = useMemo(() => new Set(favorites.map((favorite) => favorite.href)), [favorites]);
  const recentPageVisits = useMemo(
    () => new Map(recentPages.map((page) => [page.href, page.visitedAt])),
    [recentPages],
  );

  const close = () => handleOpenChange(false);

  const navigateTo = (href: string) => {
    if (query.trim()) addRecentSearch(query);
    router.push(href);
    close();
  };

  const pinToggleForHref = (href: string) => {
    const item = ALL_NAV_ITEMS.find((entry) => entry.href === href);
    const favorite: Favorite = {
      id: href,
      href,
      label: item?.label ?? href,
      iconName: item?.label ?? href,
    };
    toggleFavorite(favorite);
  };

  // Global + page-contextual commands. Page actions reuse the FloatingActionButton's
  // window CustomEvent bus, so the same handlers the FAB triggers run from the keyboard.
  const actions = useMemo<CommandAction[]>(() => {
    const dispatch = (name: string) => window.dispatchEvent(new CustomEvent(name));
    const items: CommandAction[] = [];

    if (pathname === "/game-hub" && can("game-hub:write")) {
      items.push({ id: "act-new-server", title: "New game server", subtitle: "Deploy a server", icon: Plus, keywords: "create game hub", run: () => router.push("/game-hub/new") });
    }
    if (pathname === "/game-hub" && can("game-hub:admin", "/game-hub/")) {
      items.push({ id: "act-cleanup-pvcs", title: "Cleanup PVCs", subtitle: "Reclaim game-hub storage", icon: HardDrive, keywords: "volumes disk", run: () => dispatch("fab:game-hub:cleanup-pvcs") });
      items.push({ id: "act-import-config", title: "Import config", subtitle: "Load a server config", icon: Upload, keywords: "upload game", run: () => dispatch("fab:game-hub:import-config") });
    }
    if (pathname === "/routes" && searchParams?.get("tab") === "dns" && can("config:write")) {
      items.push({ id: "act-add-dns", title: "Add DNS record", subtitle: "Create a DNS entry", icon: Globe, keywords: "route domain", run: () => dispatch("fab:dns:add") });
    }
    if ((pathname.startsWith("/users") || pathname === "/rbac") && can("users:invite")) {
      items.push({ id: "act-invite-user", title: "Invite user", subtitle: "Send an access invite", icon: UserPlus, keywords: "add member people access", run: () => dispatch("fab:users:invite") });
    }
    if ((pathname === "/apps" || pathname === "/community-apps") && can("catalog:write")) {
      items.push({ id: "act-install-app", title: "Install app", subtitle: "Add from the catalog", icon: Layers, keywords: "deploy catalog", run: () => dispatch("fab:apps:install") });
    }
    if ((pathname === "/logs" || pathname === "/log-analytics") && can("cluster:read")) {
      items.push({ id: "act-export-logs", title: "Export logs", subtitle: "Download current logs", icon: FileText, keywords: "download save", run: () => dispatch("fab:logs:export") });
    }
    if ((pathname.startsWith("/security") || pathname === "/image-vulnerabilities") && can("security:read")) {
      items.push({ id: "act-run-scan", title: "Run security scan", subtitle: "Scan for vulnerabilities", icon: Shield, keywords: "trivy cve audit", run: () => dispatch("fab:security:scan") });
    }
    if ((["/home", "/cluster", "/health", "/status"].includes(pathname) || pathname.startsWith("/gitops")) && can("apps:sync")) {
      items.push({
        id: "act-sync-all", title: "Sync all ArgoCD apps", subtitle: "Reconcile the platform", icon: RefreshCw, keywords: "gitops deploy reconcile",
        run: async () => {
          try {
            const res = await fetch("/api/argocd/sync-all", { method: "POST" });
            if (res.ok) toast.success("Sync triggered");
            else toast.error("Sync failed");
          } catch {
            toast.error("Sync failed");
          }
        },
      });
    }
    if (["/home", "/cluster", "/health", "/status"].includes(pathname)) {
      items.push({ id: "act-view-events", title: "View cluster events", subtitle: "Open the events stream", icon: Bell, keywords: "activity log", run: () => router.push("/events") });
    }

    const currentNavItem = ALL_NAV_ITEMS.find((entry) => entry.href === pathname);
    if (currentNavItem) {
      const pinned = isFavorite(pathname);
      items.push({
        id: "act-pin-page",
        title: pinned ? "Unpin this page" : "Pin this page",
        subtitle: currentNavItem.label,
        icon: pinned ? PinOff : Pin,
        keywords: "favorite bookmark quick access",
        run: () => pinToggleForHref(pathname),
      });
    }

    const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    const nextDensity = DENSITY_ORDER[(DENSITY_ORDER.indexOf(settings.density) + 1) % DENSITY_ORDER.length];
    const themeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

    items.push({ id: "act-theme", title: "Toggle theme", subtitle: `${theme} → ${nextTheme}`, icon: themeIcon, keywords: "dark light appearance color", run: () => setTheme(nextTheme) });
    items.push({ id: "act-density", title: "Cycle density", subtitle: `${settings.density} → ${nextDensity}`, icon: Rows3, keywords: "compact comfortable spacious spacing", run: () => updateSetting("density", nextDensity) });
    items.push({ id: "act-simple-mode", title: simpleMode ? "Turn off Simple mode" : "Turn on Simple mode", subtitle: "Reduce interface complexity", icon: Wand2, keywords: "beginner basic advanced", run: () => toggleSimpleMode() });
    items.push({ id: "act-refresh", title: "Refresh this view", subtitle: "Reload data", icon: Zap, keywords: "reload update", run: () => router.refresh() });
    items.push({ id: "act-shortcuts", title: "Keyboard shortcuts", subtitle: "Show the shortcut reference", icon: Keyboard, keywords: "keys help hotkeys", run: () => window.dispatchEvent(new CustomEvent(OPEN_KEYBOARD_SHORTCUTS_EVENT)) });
    items.push({ id: "act-signout", title: "Sign out", subtitle: "End your session", icon: LogOut, keywords: "logout leave exit", run: () => signOut({ callbackUrl: "/auth/signin" }) });

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters/dispatchers; recompute on the reactive state below
  }, [pathname, searchParams, theme, settings.density, simpleMode, favorites]);

  const actionEntries = useMemo<PaletteEntry[]>(() => {
    const runAction = (action: CommandAction) => () => {
      action.run();
      close();
    };

    if (!query.trim()) {
      return actions.map((action) => ({
        id: action.id,
        title: action.title,
        subtitle: action.subtitle,
        icon: <action.icon className="h-4 w-4" aria-hidden="true" />,
        run: runAction(action),
      }));
    }

    const scored: Array<{ score: number; entry: PaletteEntry }> = [];
    for (const action of actions) {
      const titleMatch = fuzzyMatch(action.title, query);
      const keywordMatch = action.keywords ? fuzzyMatch(action.keywords, query) : null;
      if (!titleMatch && !keywordMatch) continue;
      const score = (titleMatch?.score ?? 0) + (keywordMatch ? keywordMatch.score * 0.5 : 0);
      const entry: PaletteEntry = {
        id: action.id,
        title: action.title,
        subtitle: action.subtitle,
        icon: <action.icon className="h-4 w-4" aria-hidden="true" />,
        matchIndices: titleMatch?.indices,
        run: runAction(action),
      };
      scored.push({ score, entry });
    }
    return scored
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
      .map((value) => value.entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query + actions drive recompute; close is stable enough for the palette lifecycle
  }, [actions, query]);

  const quickAccessEntries = useMemo<PaletteEntry[]>(() => {
    const navMap = new Map(ALL_NAV_ITEMS.map((item) => [item.href, item]));
    const seen = new Set<string>();
    const entries: PaletteEntry[] = [];

    for (const href of favoriteHrefs) {
      const item = navMap.get(href);
      if (!item || seen.has(href)) continue;
      seen.add(href);
      entries.push({
        id: `quick-favorite-${href}`,
        title: item.label,
        subtitle: item.description ?? "Pinned page",
        icon: <Star className="h-4 w-4 text-yellow-400" aria-hidden="true" />,
        badge: "Pinned",
        badgeColor: "bg-yellow-500/10 text-yellow-200",
        favoriteHref: href,
        run: () => navigateTo(href),
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
        icon: <span className="text-base" aria-hidden="true">🕘</span>,
        badge: "Recent",
        badgeColor: "bg-sky-500/10 text-sky-200",
        favoriteHref: page.href,
        run: () => navigateTo(page.href),
      });
    }

    return entries.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- navigateTo closes over query but the hrefs are what matter
  }, [favoriteHrefs, recentPages]);

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
    const result: DisplaySection[] = [];

    if (actionEntries.length > 0) {
      result.push({ key: "actions", label: "Actions", icon: Command, entries: actionEntries });
    }

    if (!query.trim()) {
      if (quickAccessEntries.length > 0) {
        result.push({ key: "quick-access", label: "Quick access", icon: Star, entries: quickAccessEntries });
      }
      return result;
    }

    for (const key of CATEGORY_ORDER) {
      const category = normalizeCategory(key);
      const entries = [...results[key]]
        .map((item) => {
          const match = fuzzyMatch(item.title, query);
          const score = scoreResult(item, query, favoriteHrefs, recentPageVisits) + (match?.score ?? 0);
          return { item, score, indices: match?.indices };
        })
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.item.title.localeCompare(right.item.title);
        })
        .map(({ item, indices }): PaletteEntry => {
          const isNav = item.category === "navigation";
          const navItem = ALL_NAV_ITEMS.find((entry) => entry.href === item.href);
          return {
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            icon: <span className="text-base text-gray-700 dark:text-[#d4d4d4]" aria-hidden="true">{item.icon ?? "•"}</span>,
            badge: item.badge,
            badgeColor: item.badgeColor,
            matchIndices: indices,
            favoriteHref: isNav && navItem ? item.href : undefined,
            run: () => navigateTo(item.href),
          };
        });

      if (entries.length > 0) {
        result.push({
          key,
          label: SEARCH_CATEGORY_LABELS[category],
          icon: CATEGORY_ICONS[category],
          entries,
        });
      }
    }

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- navigateTo is recreated each render but its href targets are stable
  }, [actionEntries, favoriteHrefs, query, quickAccessEntries, recentPageVisits, results]);

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
        <Dialog.Overlay className="fixed inset-0 z-overlay bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-modal overflow-hidden bg-white dark:bg-[#111] p-0 shadow-2xl outline-none sm:inset-x-auto sm:left-1/2 sm:top-[14vh] sm:w-[min(92vw,42rem)] sm:-translate-x-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a]">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center border-b border-gray-200 dark:border-[#2a2a2a] px-4 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] sm:pt-0">
            <SearchIcon className="mr-2 h-4 w-4 shrink-0 text-gray-400 dark:text-[#9a9a9a]" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={open}
              aria-controls="infraweaver-global-search-results"
              aria-activedescendant={activeResult ? `infraweaver-search-option-${activeResult.id}` : undefined}
              className="flex-1 bg-transparent py-3.5 text-base text-gray-900 dark:text-[#f2f2f2] outline-none placeholder:text-gray-400 dark:placeholder:text-[#8a8a8a] sm:text-sm"
              placeholder="Search or run a command…"
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
                  flatResults[activeIndex]?.run();
                }
              }}
            />
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin text-gray-400 dark:text-[#9a9a9a]" /> : null}
            <kbd className="hidden rounded border border-gray-200 dark:border-[#333] px-1 text-xs text-gray-400 dark:text-[#8a8a8a] sm:inline-flex">↑↓ ↵ ESC</kbd>
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="ml-1 inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 dark:text-[#9a9a9a] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] sm:hidden"
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
                    className="text-[11px] text-gray-400 dark:text-[#9a9a9a] transition-colors hover:text-gray-900 dark:hover:text-[#f2f2f2]"
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
              <div className="px-4 py-2">
                {[0, 1, 2, 3].map((index) => (
                  <SkeletonRow key={index} columns={2} />
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
                  {section.entries.map((entry) => {
                    const index = flatResults.findIndex((item) => item.id === entry.id);
                    const isActive = index === activeIndex;
                    const pinned = entry.favoriteHref ? isFavorite(entry.favoriteHref) : false;
                    return (
                      <button
                        key={entry.id}
                        id={`infraweaver-search-option-${entry.id}`}
                        ref={(node) => {
                          optionRefs.current[entry.id] = node;
                        }}
                        role="option"
                        aria-selected={isActive}
                        className={cn(
                          "group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors focus:outline-none",
                          isActive ? "bg-white dark:bg-[#1a1a1a]" : "hover:bg-[#171717]"
                        )}
                        onMouseEnter={() => index >= 0 && setActiveIndex(index)}
                        onClick={entry.run}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-gray-500 dark:text-[#9a9a9a]">
                          {entry.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-gray-900 dark:text-[#f2f2f2]">
                            <HighlightedTitle title={entry.title} indices={entry.matchIndices} />
                          </div>
                          {entry.subtitle ? (
                            <div className="truncate text-xs text-gray-500 dark:text-[#888]">{entry.subtitle}</div>
                          ) : null}
                        </div>
                        {entry.favoriteHref ? (
                          <span
                            role="button"
                            tabIndex={-1}
                            aria-label={pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`}
                            title={pinned ? "Unpin" : "Pin"}
                            onClick={(event) => {
                              event.stopPropagation();
                              pinToggleForHref(entry.favoriteHref!);
                            }}
                            className={cn(
                              "inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                              pinned
                                ? "text-yellow-400 hover:bg-yellow-500/10"
                                : "text-gray-400 opacity-0 hover:bg-gray-100 hover:text-gray-700 focus-visible:opacity-100 group-hover:opacity-100 dark:text-[#9a9a9a] dark:hover:bg-[#222] dark:hover:text-[#f2f2f2]",
                            )}
                          >
                            <Star className={cn("h-3.5 w-3.5", pinned && "fill-current")} aria-hidden="true" />
                          </span>
                        ) : null}
                        {entry.badge ? (
                          <span className={`rounded-full px-1.5 py-0.5 text-xs ${entry.badgeColor ?? "bg-gray-50 dark:bg-[#1f1f1f] text-gray-500 dark:text-[#888]"}`}>
                            {entry.badge}
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
              <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-[#888]">Pinned pages, commands and recent searches will show up here.</div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
