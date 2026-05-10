"use client";
import { useEffect, useState, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, Box, Activity, Network, Cog, HardDrive,
  FileText, Users, KeyRound, Terminal, History, Search, X, ShieldCheck, Server,
  PlusCircle, Package,
} from "lucide-react";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { cn } from "@/lib/utils";
import Fuse from "fuse.js";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard", shortcut: "G D", category: "Core" },
  { href: "/apps", icon: Box, label: "Applications", shortcut: "G A", category: "Core" },
  { href: "/catalog-install", icon: PlusCircle, label: "App Installer", shortcut: "G I", category: "Core" },
  { href: "/events", icon: History, label: "Activity Log", shortcut: "G E", category: "Core" },
  { href: "/config", icon: Cog, label: "Config Editor", shortcut: "G C", category: "Platform" },
  { href: "/users", icon: Users, label: "Users", shortcut: "G U", category: "Platform" },
  { href: "/registry", icon: Package, label: "Registry", shortcut: "G R", category: "Platform" },
  { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L", category: "Platform" },
  { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S", category: "Infrastructure" },
  { href: "/network", icon: Network, label: "Network", shortcut: "G N", category: "Infrastructure" },
  { href: "/health", icon: Activity, label: "Health", shortcut: "G H", category: "Infrastructure" },
  { href: "/security", icon: ShieldCheck, label: "Security", shortcut: "G Y", category: "Infrastructure" },
  { href: "/cluster", icon: Server, label: "Cluster", shortcut: "G K", category: "Infrastructure" },
  { href: "/exec", icon: Terminal, label: "Exec", shortcut: "G X", category: "Platform" },
  { href: "/settings", icon: KeyRound, label: "Settings", shortcut: "", category: "Settings" },
];

const RECENT_KEY = "cmd-palette-recent";

function getRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}
function addRecent(href: string) {
  const prev = getRecent().filter(h => h !== href);
  localStorage.setItem(RECENT_KEY, JSON.stringify([href, ...prev].slice(0, 5)));
}

export function CommandPalette() {
  const { open, setOpen } = useCommandPaletteStore();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const fuse = useMemo(() => new Fuse(navItems, {
    keys: ["label", "category"],
    threshold: 0.4,
    includeScore: true,
  }), []);

  const filtered = useMemo(() => {
    if (!query.trim()) return navItems;
    return fuse.search(query).map(r => r.item);
  }, [query, fuse]);

  const grouped = useMemo(() => {
    if (query.trim()) return null;
    const cats: Record<string, typeof navItems> = {};
    navItems.forEach(item => {
      if (!cats[item.category]) cats[item.category] = [];
      cats[item.category].push(item);
    });
    return cats;
  }, [query]);

  const recentItems = navItems.filter(i => recentHrefs.includes(i.href));

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
      setQuery("");
      setActiveIndex(0);
      setRecentHrefs(getRecent());
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

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
        addRecent(item.href);
        router.push(item.href);
        setOpen(false);
      }
    }
  };

  const navigate = (href: string) => {
    addRecent(href);
    router.push(href);
    setOpen(false);
  };

  const categoryColors: Record<string, string> = {
    Core: "text-indigo-400",
    Platform: "text-violet-400",
    Infrastructure: "text-cyan-400",
    Settings: "text-slate-400",
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-w-lg bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
              <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search pages..."
                className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
              />
              <button
                onClick={() => setOpen(false)}
                className="text-slate-500 hover:text-slate-300 transition-colors"
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
                          : "text-slate-300 hover:bg-white/5"
                      )}
                    >
                      <item.icon className="w-4 h-4 flex-shrink-0 text-slate-400" />
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
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors text-slate-300 hover:bg-white/5"
                        >
                          <item.icon className="w-4 h-4 flex-shrink-0 text-slate-500" />
                          <span className="flex-1 text-sm">{item.label}</span>
                          <span className="text-[10px] text-slate-600">Recent</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Grouped items */}
                  {grouped && Object.entries(grouped).map(([cat, items]) => (
                    <div key={cat} className="mb-2">
                      <p className={cn("px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider", categoryColors[cat])}>{cat}</p>
                      {items.map((item, i) => {
                        const flatIndex = filtered.indexOf(item);
                        return (
                          <button
                            key={item.href}
                            onClick={() => navigate(item.href)}
                            onMouseEnter={() => setActiveIndex(flatIndex >= 0 ? flatIndex : i)}
                            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors text-slate-300 hover:bg-white/5"
                          >
                            <item.icon className="w-4 h-4 flex-shrink-0 text-slate-400" />
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

            <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3 text-xs text-slate-600">
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
