"use client";
import { useEffect, useState, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { Clock3, Link2, RotateCw, Search, SunMoon, X } from "lucide-react";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, type NavItem } from "@/lib/nav-config";
import Fuse from "fuse.js";

// Single source of truth: every navigable page comes from NAV_GROUPS, so the
// palette stays in sync with the sidebar instead of duplicating a stale list.
interface PaletteItem extends NavItem {
  category: string;
}

const navItems: PaletteItem[] = NAV_GROUPS.flatMap(group =>
  group.items.map(item => ({ ...item, category: group.label }))
);

const navByHref = new Map(navItems.map(item => [item.href, item]));

// Deterministic accent per category, cycling a fixed palette in group order.
const COLOR_CYCLE = [
  "text-indigo-400", "text-violet-400", "text-cyan-400", "text-emerald-400",
  "text-amber-400", "text-rose-400", "text-sky-400", "text-fuchsia-400",
];
const categoryColors: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.map((group, i) => [group.label, COLOR_CYCLE[i % COLOR_CYCLE.length]])
);

interface RecentItem {
  href: string;
  label: string;
  icon: NavItem["icon"];
}

// Quick actions an operator can run from the keyboard without leaving the
// palette. These run on click and aren't part of the arrow-key navigation
// model, which stays focused on page navigation.
interface PaletteAction {
  id: string;
  label: string;
  icon: NavItem["icon"];
  run: () => void;
}

export function CommandPalette() {
  const { open, setOpen } = useCommandPaletteStore();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const { recentPages } = useRecentPages();
  const { copy } = useCopyToClipboard();
  const { resolvedTheme, setTheme } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);

  const actions: PaletteAction[] = useMemo(() => [
    {
      id: "copy-url",
      label: "Copy current URL",
      icon: Link2,
      run: () => { void copy(window.location.href); },
    },
    {
      id: "reload",
      label: "Reload this page",
      icon: RotateCw,
      run: () => window.location.reload(),
    },
    {
      id: "toggle-theme",
      label: "Toggle theme",
      icon: SunMoon,
      run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    },
  ], [copy, resolvedTheme, setTheme]);

  const runAction = (action: PaletteAction) => {
    action.run();
    setOpen(false);
  };

  const fuse = useMemo(() => new Fuse(navItems, {
    keys: ["label", "category", "description", "keywords"],
    threshold: 0.4,
    includeScore: true,
  }), []);

  const filtered = useMemo(() => {
    if (!query.trim()) return navItems;
    return fuse.search(query).map(r => r.item);
  }, [query, fuse]);

  // Recent pages come from the app-wide visit history (server-backed
  // preferences), so the palette reflects everywhere the operator has been —
  // not only pages opened from the palette itself. Skip the current page.
  const recentItems: RecentItem[] = useMemo(() => (
    recentPages
      .filter(page => page.href !== pathname)
      .slice(0, 5)
      .map(page => {
        const navItem = navByHref.get(page.href);
        return { href: page.href, label: navItem?.label ?? page.title, icon: navItem?.icon ?? Clock3 };
      })
  ), [recentPages, pathname]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(!open);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with an external/browser store or dependency-driven reset; not derived render state
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with an external/browser store or dependency-driven reset; not derived render state
  useEffect(() => { setActiveIndex(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = filtered[activeIndex];
      if (item) {
        router.push(item.href);
        setOpen(false);
      }
    }
  };

  const navigate = (href: string) => {
    router.push(href);
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-modal flex items-start justify-center pt-[15vh] px-4"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-w-lg bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-white/5">
              <Search className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search pages..."
                className="flex-1 bg-transparent text-sm text-gray-900 dark:text-white placeholder-slate-500 focus:outline-none"
              />
              <button
                onClick={() => setOpen(false)}
                className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
              {/* Fuzzy search results */}
              {query.trim() ? (
                filtered.length === 0 ? (
                  <div className="py-8 text-center text-slate-500 text-sm">No results for &quot;{query}&quot;</div>
                ) : (
                  filtered.map((item, i) => (
                    <button
                      key={item.href}
                      onClick={() => navigate(item.href)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                        i === activeIndex
                          ? "bg-indigo-500/20 text-indigo-300"
                          : "text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5"
                      )}
                    >
                      <item.icon className="w-4 h-4 flex-shrink-0 text-slate-500 dark:text-slate-400" />
                      <span className="flex-1 text-sm font-medium">{item.label}</span>
                      <span className={cn("text-[10px] font-semibold", categoryColors[item.category])}>{item.category}</span>
                      {item.shortcut && <span className="text-xs text-slate-600 font-mono">{item.shortcut}</span>}
                    </button>
                  ))
                )
              ) : (
                <>
                  {/* Recent */}
                  {recentItems.length > 0 && (
                    <div className="mb-2">
                      <p className="px-3 py-1.5 text-[10px] font-semibold text-slate-600 uppercase tracking-wider">Recent</p>
                      {recentItems.map(item => (
                        <button
                          key={item.href}
                          onClick={() => navigate(item.href)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5"
                        >
                          <item.icon className="w-4 h-4 flex-shrink-0 text-slate-500" />
                          <span className="flex-1 text-sm">{item.label}</span>
                          <span className="text-[10px] text-slate-600">Recent</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Actions — quick keyboard-reachable operator actions */}
                  <div className="mb-2">
                    <p className="px-3 py-1.5 text-[10px] font-semibold text-slate-600 uppercase tracking-wider">Actions</p>
                    {actions.map(action => (
                      <button
                        key={action.id}
                        onClick={() => runAction(action)}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5"
                      >
                        <action.icon className="w-4 h-4 flex-shrink-0 text-slate-500 dark:text-slate-400" />
                        <span className="flex-1 text-sm font-medium">{action.label}</span>
                      </button>
                    ))}
                  </div>
                  {/* Grouped items — mirror the sidebar's group order */}
                  {NAV_GROUPS.map(group => (
                    <div key={group.id} className="mb-2">
                      <p className={cn("px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider", categoryColors[group.label])}>{group.label}</p>
                      {group.items.map((item, i) => {
                        const flatIndex = navItems.findIndex(n => n.href === item.href);
                        return (
                          <button
                            key={item.href}
                            onClick={() => navigate(item.href)}
                            onMouseEnter={() => setActiveIndex(flatIndex >= 0 ? flatIndex : i)}
                            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5"
                          >
                            <item.icon className="w-4 h-4 flex-shrink-0 text-slate-500 dark:text-slate-400" />
                            <span className="flex-1 text-sm font-medium">{item.label}</span>
                            {item.shortcut && <span className="text-xs text-slate-600 font-mono">{item.shortcut}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="px-4 py-2 border-t border-gray-200 dark:border-white/5 flex items-center gap-3 text-xs text-slate-600">
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span>esc close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
