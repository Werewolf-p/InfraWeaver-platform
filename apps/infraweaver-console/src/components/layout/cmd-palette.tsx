"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Box,
  FileText,
  Gamepad2,
  LayoutDashboard,
  Search,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { cn } from "@/lib/utils";

const RECENT_KEY = "infraweaver:cmd-palette-recent";
const MAX_RECENT = 5;
const CATEGORY_ORDER = ["Navigation", "Apps", "Pods", "Game Servers"] as const;

type PaletteCategory = (typeof CATEGORY_ORDER)[number];

type IconType = typeof LayoutDashboard;

interface PaletteItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  category: PaletteCategory;
  icon: IconType;
  keywords?: string[];
}

interface StoredRecentItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  category: PaletteCategory;
}

const categoryIcons: Record<PaletteCategory, IconType> = {
  Navigation: LayoutDashboard,
  Apps: Box,
  Pods: Server,
  "Game Servers": Gamepad2,
};

const navigationItems: PaletteItem[] = [
  { id: "nav-dashboard", title: "Dashboard", subtitle: "Overview", href: "/", category: "Navigation", icon: LayoutDashboard },
  { id: "nav-apps", title: "Applications", subtitle: "ArgoCD workloads", href: "/apps", category: "Navigation", icon: Box },
  { id: "nav-pods", title: "Pods", subtitle: "Cluster pods", href: "/pods", category: "Navigation", icon: Server },
  { id: "nav-logs", title: "Pod Logs", subtitle: "Live log streaming", href: "/logs", category: "Navigation", icon: FileText },
  { id: "nav-health", title: "Health", subtitle: "Platform health", href: "/health", category: "Navigation", icon: Activity },
  { id: "nav-gameservers", title: "Game Servers", subtitle: "Dedicated servers", href: "/gameservers", category: "Navigation", icon: Gamepad2 },
  { id: "nav-whats-new", title: "What’s New", subtitle: "Release notes", href: "/changelog", category: "Navigation", icon: Sparkles },
];

function loadRecent(): PaletteItem[] {
  if (typeof window === "undefined") return [];

  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as StoredRecentItem[];
    return parsed.map((item) => ({
      ...item,
      icon: categoryIcons[item.category],
    }));
  } catch {
    return [];
  }
}

function saveRecent(item: PaletteItem) {
  if (typeof window === "undefined") return;

  const nextItem: StoredRecentItem = {
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    href: item.href,
    category: item.category,
  };

  const existing = loadRecent().filter((entry) => entry.href !== item.href);
  const next = [nextItem, ...existing.map(({ id, title, subtitle, href, category }) => ({ id, title, subtitle, href, category }))].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function derivePathItem(pathname: string): PaletteItem | null {
  const matched = navigationItems.find((item) => item.href === pathname);
  if (matched) return matched;

  const appMatch = pathname.match(/^\/apps\/([^/]+)$/);
  if (appMatch) {
    return {
      id: `recent-app-${appMatch[1]}`,
      title: decodeURIComponent(appMatch[1]),
      subtitle: "Application detail",
      href: pathname,
      category: "Apps",
      icon: Box,
    };
  }

  const podMatch = pathname.match(/^\/pods\/([^/]+)\/([^/]+)$/);
  if (podMatch) {
    return {
      id: `recent-pod-${podMatch[1]}-${podMatch[2]}`,
      title: decodeURIComponent(podMatch[2]),
      subtitle: decodeURIComponent(podMatch[1]),
      href: pathname,
      category: "Pods",
      icon: Server,
    };
  }

  const gameServerMatch = pathname.match(/^\/(?:game-hub|gameservers)\/([^/]+)$/);
  if (gameServerMatch) {
    return {
      id: `recent-gameserver-${gameServerMatch[1]}`,
      title: decodeURIComponent(gameServerMatch[1]),
      subtitle: "Game server detail",
      href: pathname,
      category: "Game Servers",
      icon: Gamepad2,
    };
  }

  return null;
}

export function CmdPalette() {
  const { open, setOpen } = useCommandPaletteStore();
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [recentItems, setRecentItems] = useState<PaletteItem[]>([]);
  const [liveItems, setLiveItems] = useState<PaletteItem[]>([]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!open);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  useEffect(() => {
    const item = derivePathItem(pathname);
    if (!item) return;
    saveRecent(item);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const fetchResources = async () => {
      setLoading(true);
      const [appsResult, podsResult, gameServersResult] = await Promise.allSettled([
        fetch("/api/argocd/apps").then((response) => (response.ok ? response.json() : [])),
        fetch("/api/pods").then((response) => (response.ok ? response.json() : [])),
        fetch("/api/gameservers").then((response) => (response.ok ? response.json() : [])),
      ]);

      const nextItems: PaletteItem[] = [];

      if (appsResult.status === "fulfilled") {
        const apps = appsResult.value as Array<{ metadata?: { name?: string }; spec?: { destination?: { namespace?: string } } }>;
        nextItems.push(
          ...apps.slice(0, 12).map((app) => ({
            id: `app-${app.metadata?.name ?? "unknown"}`,
            title: app.metadata?.name ?? "Unknown app",
            subtitle: app.spec?.destination?.namespace ?? "argocd",
            href: `/apps/${encodeURIComponent(app.metadata?.name ?? "")}`,
            category: "Apps" as const,
            icon: Box,
            keywords: [app.spec?.destination?.namespace ?? ""],
          }))
        );
      }

      if (podsResult.status === "fulfilled") {
        const pods = podsResult.value as Array<{ name?: string; namespace?: string; status?: string }>;
        const namespaces = Array.from(new Set(pods.map((pod) => pod.namespace).filter(Boolean) as string[])).slice(0, 6);

        nextItems.push(
          ...pods.slice(0, 16).map((pod) => ({
            id: `pod-${pod.namespace ?? "default"}-${pod.name ?? "unknown"}`,
            title: pod.name ?? "Unknown pod",
            subtitle: `${pod.namespace ?? "default"} · ${pod.status ?? "Unknown"}`,
            href: `/pods/${encodeURIComponent(pod.namespace ?? "default")}/${encodeURIComponent(pod.name ?? "")}`,
            category: "Pods" as const,
            icon: Server,
            keywords: [pod.namespace ?? "", pod.status ?? ""],
          }))
        );

        nextItems.push(
          ...namespaces.map((namespace) => ({
            id: `namespace-${namespace}`,
            title: `Namespace: ${namespace}`,
            subtitle: "Browse related pods",
            href: "/pods",
            category: "Pods" as const,
            icon: Server,
            keywords: [namespace],
          }))
        );
      }

      if (gameServersResult.status === "fulfilled") {
        const gameServers = gameServersResult.value as Array<{ name?: string; displayName?: string; gameType?: string; serviceStatus?: string }>;
        nextItems.push(
          ...gameServers.slice(0, 12).map((server) => ({
            id: `gameserver-${server.name ?? "unknown"}`,
            title: server.displayName || server.name || "Unknown server",
            subtitle: `${server.gameType ?? "custom"} · ${server.serviceStatus ?? "unknown"}`,
            href: `/game-hub/${encodeURIComponent(server.name ?? "")}`,
            category: "Game Servers" as const,
            icon: Gamepad2,
            keywords: [server.name ?? "", server.gameType ?? "", server.serviceStatus ?? ""],
          }))
        );
      }

      setLiveItems(nextItems);
      setLoading(false);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("");
    setSelectedIndex(0);
    setRecentItems(loadRecent());
    void fetchResources();
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const allItems = useMemo(() => [...navigationItems, ...liveItems], [liveItems]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) return allItems;
    const value = query.toLowerCase();
    return allItems.filter((item) => {
      const haystack = [item.title, item.subtitle, ...(item.keywords ?? [])].join(" ").toLowerCase();
      return haystack.includes(value);
    });
  }, [allItems, query]);

  const sections = useMemo(() => {
    if (query.trim()) {
      return CATEGORY_ORDER.map((category) => ({
        label: category,
        items: filteredItems.filter((item) => item.category === category),
      })).filter((section) => section.items.length > 0);
    }

    const categorySections = CATEGORY_ORDER.map((category) => ({
      label: category,
      items: (category === "Navigation" ? navigationItems : liveItems.filter((item) => item.category === category)).slice(0, category === "Pods" ? 10 : 8),
    })).filter((section) => section.items.length > 0);

    return recentItems.length > 0
      ? [{ label: "Recent", items: recentItems }, ...categorySections]
      : categorySections;
  }, [filteredItems, liveItems, query, recentItems]);

  const flatItems = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => Math.min(current + 1, Math.max(flatItems.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter") {
        const item = flatItems[selectedIndex];
        if (!item) return;
        saveRecent(item);
        setRecentItems(loadRecent());
        setOpen(false);
        router.push(item.href);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flatItems, open, router, selectedIndex, setOpen]);

  const navigate = (item: PaletteItem) => {
    saveRecent(item);
    setRecentItems(loadRecent());
    setOpen(false);
    router.push(item.href);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-start justify-center px-4 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="Search navigation, apps, pods, and game servers..."
                className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 outline-none"
              />
              {loading ? <LoadingSpinner size="sm" color="white" /> : null}
              <button onClick={() => setOpen(false)} className="text-slate-500 transition hover:text-slate-300">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[65vh] overflow-y-auto px-2 py-3">
              {sections.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-slate-500">No results found.</div>
              ) : (
                (() => {
                  let itemIndex = 0;
                  return sections.map((section) => (
                    <div key={section.label} className="mb-4 last:mb-0">
                      <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                        {section.label}
                      </p>
                      <div className="space-y-1">
                        {section.items.map((item) => {
                          const currentIndex = itemIndex;
                          itemIndex += 1;
                          return (
                            <button
                              key={item.id}
                              onClick={() => navigate(item)}
                              onMouseEnter={() => setSelectedIndex(currentIndex)}
                              className={cn(
                                "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
                                selectedIndex === currentIndex
                                  ? "bg-indigo-500/15 text-white"
                                  : "text-slate-300 hover:bg-white/5"
                              )}
                            >
                              <item.icon className="h-4 w-4 flex-shrink-0 text-slate-400" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{item.title}</span>
                                <span className="block truncate text-xs text-slate-500">{item.subtitle}</span>
                              </span>
                              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                                {item.category}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-white/10 px-4 py-2 text-xs text-slate-500">
              <span>↑↓ navigate</span>
              <span>Enter open</span>
              <span>Esc close</span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
