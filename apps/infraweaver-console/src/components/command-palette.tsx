"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  Search, X, LayoutDashboard, Box, Settings, FileText,
  Activity, Network, HardDrive, Users, Package, ShieldCheck,
  Server, Cog, PlusCircle, History, Home, Sparkles, ArrowRight,
  Clock,
} from "lucide-react";
import Fuse from "fuse.js";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { cn } from "@/lib/utils";

interface PaletteItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  icon: React.ElementType;
  shortcut?: string;
  category: "page" | "action";
}

const pages: PaletteItem[] = [
  { id: "home", title: "Home Portal", subtitle: "Core", href: "/home", icon: Home, shortcut: "G O", category: "page" },
  { id: "dashboard", title: "Dashboard", subtitle: "Core", href: "/", icon: LayoutDashboard, shortcut: "G D", category: "page" },
  { id: "apps", title: "Applications", subtitle: "Core", href: "/apps", icon: Box, shortcut: "G A", category: "page" },
  { id: "catalog-install", title: "App Installer", subtitle: "Core", href: "/catalog-install", icon: PlusCircle, shortcut: "G I", category: "page" },
  { id: "events", title: "Activity Log", subtitle: "Core", href: "/events", icon: History, shortcut: "G E", category: "page" },
  { id: "config", title: "Config Editor", subtitle: "Platform", href: "/config", icon: Cog, shortcut: "G C", category: "page" },
  { id: "users", title: "Users", subtitle: "Platform", href: "/users", icon: Users, shortcut: "G U", category: "page" },
  { id: "registry", title: "Registry", subtitle: "Platform", href: "/registry", icon: Package, shortcut: "G R", category: "page" },
  { id: "logs", title: "Pod Logs", subtitle: "Platform", href: "/logs", icon: FileText, shortcut: "G L", category: "page" },
  { id: "storage", title: "Storage", subtitle: "Infrastructure", href: "/storage", icon: HardDrive, shortcut: "G S", category: "page" },
  { id: "network", title: "Network", subtitle: "Infrastructure", href: "/network", icon: Network, shortcut: "G N", category: "page" },
  { id: "health", title: "Health", subtitle: "Infrastructure", href: "/health", icon: Activity, shortcut: "G H", category: "page" },
  { id: "security", title: "Security", subtitle: "Infrastructure", href: "/security", icon: ShieldCheck, shortcut: "G Y", category: "page" },
  { id: "cluster", title: "Cluster", subtitle: "Infrastructure", href: "/cluster", icon: Server, shortcut: "G K", category: "page" },
  { id: "settings", title: "Settings", subtitle: "Settings", href: "/settings", icon: Settings, category: "page" },
  { id: "changelog", title: "What's New", subtitle: "Settings", href: "/changelog", icon: Sparkles, category: "page" },
];

const actions: PaletteItem[] = [
  { id: "sync-all", title: "Sync all apps", subtitle: "Action", href: "/apps", icon: Box, category: "action" },
  { id: "open-logs", title: "Open pod logs", subtitle: "Action", href: "/logs", icon: FileText, category: "action" },
  { id: "go-settings", title: "Navigate to Settings", subtitle: "Action", href: "/settings", icon: Settings, category: "action" },
  { id: "view-health", title: "View cluster health", subtitle: "Action", href: "/health", icon: Activity, category: "action" },
];

const allItems = [...pages, ...actions];

const fuse = new Fuse(allItems, {
  keys: ["title", "subtitle"],
  threshold: 0.35,
});

const RECENT_KEY = "cmd-palette-recent";
const MAX_RECENT = 5;

function loadRecent(): PaletteItem[] {
  if (typeof window === "undefined") return [];
  try {
    const ids = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    return ids.map(id => allItems.find(i => i.id === id)).filter(Boolean) as PaletteItem[];
  } catch {
    return [];
  }
}

function saveRecent(item: PaletteItem) {
  try {
    const existing = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    const next = [item.id, ...existing.filter(id => id !== item.id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function CommandPalette() {
  const { open, setOpen } = useCommandPaletteStore();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentItems, setRecentItems] = useState<PaletteItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = query.trim()
    ? fuse.search(query).map(r => r.item)
    : [];

  const displayItems = query.trim() ? results : recentItems;
  const showSections = !query.trim();

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setRecentItems(loadRecent());
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const navigate = useCallback(
    (item: PaletteItem) => {
      saveRecent(item);
      setOpen(false);
      setQuery("");
      router.push(item.href);
    },
    [router, setOpen]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(!open);
      }
      if (!open) return;
      if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, (showSections ? displayItems.length : results.length) - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const items = showSections ? displayItems : results;
        if (items[selectedIndex]) navigate(items[selectedIndex]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen, displayItems, results, selectedIndex, navigate, showSections]);

  const pageResults = results.filter(r => r.category === "page");
  const actionResults = results.filter(r => r.category === "action");

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh] px-4"
          onClick={() => setOpen(false)}
        >
          {/* Glass backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />

          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="relative w-full max-w-xl bg-slate-100 dark:bg-slate-900/95 backdrop-blur-xl border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-white/10">
              <Search className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search pages and actions..."
                className="flex-1 bg-transparent text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none"
              />
              {query && (
                <button onClick={() => setQuery("")} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
              <kbd className="text-[10px] text-slate-600 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5">ESC</kbd>
            </div>

            {/* Results */}
            <div className="max-h-80 overflow-y-auto">
              {showSections ? (
                displayItems.length > 0 ? (
                  <div className="py-2">
                    <div className="px-4 py-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
                      <Clock className="w-3 h-3" />
                      Recent
                    </div>
                    {displayItems.map((item, idx) => (
                      <ResultRow
                        key={item.id}
                        item={item}
                        selected={idx === selectedIndex}
                        onSelect={() => navigate(item)}
                        onHover={() => setSelectedIndex(idx)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="py-2">
                    <SectionHeader label="Pages" />
                    {pages.slice(0, 6).map((item, idx) => (
                      <ResultRow
                        key={item.id}
                        item={item}
                        selected={idx === selectedIndex}
                        onSelect={() => navigate(item)}
                        onHover={() => setSelectedIndex(idx)}
                      />
                    ))}
                    <SectionHeader label="Actions" />
                    {actions.map((item, idx) => (
                      <ResultRow
                        key={item.id}
                        item={item}
                        selected={pages.slice(0, 6).length + idx === selectedIndex}
                        onSelect={() => navigate(item)}
                        onHover={() => setSelectedIndex(pages.slice(0, 6).length + idx)}
                      />
                    ))}
                  </div>
                )
              ) : results.length > 0 ? (
                <div className="py-2">
                  {pageResults.length > 0 && (
                    <>
                      <SectionHeader label="Pages" />
                      {pageResults.map((item) => {
                        const idx = results.indexOf(item);
                        return (
                          <ResultRow
                            key={item.id}
                            item={item}
                            selected={idx === selectedIndex}
                            onSelect={() => navigate(item)}
                            onHover={() => setSelectedIndex(idx)}
                          />
                        );
                      })}
                    </>
                  )}
                  {actionResults.length > 0 && (
                    <>
                      <SectionHeader label="Actions" />
                      {actionResults.map((item) => {
                        const idx = results.indexOf(item);
                        return (
                          <ResultRow
                            key={item.id}
                            item={item}
                            selected={idx === selectedIndex}
                            onSelect={() => navigate(item)}
                            onHover={() => setSelectedIndex(idx)}
                          />
                        );
                      })}
                    </>
                  )}
                </div>
              ) : (
                <div className="py-10 text-center text-sm text-slate-500">No results for &quot;{query}&quot;</div>
              )}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-gray-200 dark:border-white/5 flex items-center gap-3 text-[10px] text-slate-600">
              <span><kbd className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-1">↑↓</kbd> navigate</span>
              <span><kbd className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-1">↵</kbd> open</span>
              <span><kbd className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-1">esc</kbd> close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
      {label}
    </div>
  );
}

function ResultRow({
  item,
  selected,
  onSelect,
  onHover,
}: {
  item: PaletteItem;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
        selected ? "bg-indigo-500/20 text-gray-900 dark:text-white" : "text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5"
      )}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <item.icon className={cn("w-4 h-4 flex-shrink-0", selected ? "text-indigo-400" : "text-slate-500")} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{item.title}</p>
        <p className="text-[11px] text-slate-500 truncate">{item.subtitle}</p>
      </div>
      {item.shortcut && (
        <span className="text-[10px] text-slate-600 font-mono flex-shrink-0">{item.shortcut}</span>
      )}
      <ArrowRight className={cn("w-3.5 h-3.5 flex-shrink-0 transition-opacity", selected ? "opacity-100 text-indigo-400" : "opacity-0")} />
    </button>
  );
}
