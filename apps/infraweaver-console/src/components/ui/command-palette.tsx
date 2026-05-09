"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, LayoutDashboard, Box, Activity, FileText, Settings,
  Network, HardDrive, Users, Package, History, Cog, Terminal,
  Zap, RefreshCw, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  action: () => void;
  group: "pages" | "actions";
}

export function CommandPalette() {
  const { isOpen, close } = useCommandPaletteStore();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = (href: string) => {
    router.push(href);
    close();
    setQuery("");
  };

  const pages: PaletteItem[] = [
    { id: "dashboard",  label: "Dashboard",      description: "Platform overview",         icon: LayoutDashboard, action: () => navigate("/"),         group: "pages" },
    { id: "apps",       label: "Applications",   description: "ArgoCD managed apps",       icon: Box,             action: () => navigate("/apps"),      group: "pages" },
    { id: "health",     label: "Health",          description: "Gatus endpoint monitoring", icon: Activity,        action: () => navigate("/health"),    group: "pages" },
    { id: "events",     label: "Activity Log",    description: "ArgoCD events",             icon: History,         action: () => navigate("/events"),    group: "pages" },
    { id: "config",     label: "Config Editor",   description: "Platform YAML config",      icon: Cog,             action: () => navigate("/config"),    group: "pages" },
    { id: "users",      label: "Users",           description: "User management",           icon: Users,           action: () => navigate("/users"),     group: "pages" },
    { id: "registry",   label: "Registry",        description: "Container registry",        icon: Package,         action: () => navigate("/registry"),  group: "pages" },
    { id: "logs",       label: "Pod Logs",        description: "Stream pod container logs", icon: FileText,        action: () => navigate("/logs"),      group: "pages" },
    { id: "storage",    label: "Storage",         description: "Longhorn volumes",          icon: HardDrive,       action: () => navigate("/storage"),   group: "pages" },
    { id: "network",    label: "Network",         description: "Netbird VPN peers",         icon: Network,         action: () => navigate("/network"),   group: "pages" },
    { id: "settings",   label: "Settings",        description: "Console settings",          icon: Settings,        action: () => navigate("/settings"),  group: "pages" },
  ];

  const actions: PaletteItem[] = [
    {
      id: "sync-all",
      label: "Sync All Apps",
      description: "Trigger ArgoCD sync for all apps",
      icon: Zap,
      group: "actions",
      action: async () => {
        close();
        setQuery("");
        await fetch("/api/argocd/sync-all", { method: "POST" });
      },
    },
    {
      id: "refresh",
      label: "Refresh Data",
      description: "Invalidate all cached queries",
      icon: RefreshCw,
      group: "actions",
      action: () => {
        close();
        setQuery("");
        window.location.reload();
      },
    },
    {
      id: "terminal",
      label: "Open Logs",
      description: "Jump to pod logs viewer",
      icon: Terminal,
      group: "actions",
      action: () => navigate("/logs"),
    },
  ];

  const allItems = [...pages, ...actions];

  const filtered = query.trim()
    ? allItems.filter(
        (item) =>
          item.label.toLowerCase().includes(query.toLowerCase()) ||
          item.description?.toLowerCase().includes(query.toLowerCase())
      )
    : allItems;

  const groupedPages = filtered.filter((i) => i.group === "pages");
  const groupedActions = filtered.filter((i) => i.group === "actions");

  const flatFiltered = [...groupedPages, ...groupedActions];

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
    }
  }, [isOpen]);

  // Global keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flatFiltered[activeIndex]?.action();
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(v) => !v && close()}>
      <Dialog.Portal>
        <AnimatePresence>
          {isOpen && (
            <>
              <Dialog.Overlay asChild>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
                />
              </Dialog.Overlay>

              <Dialog.Content asChild>
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: -10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: -10 }}
                  transition={{ type: "spring", damping: 30, stiffness: 400 }}
                  className="fixed left-1/2 top-[15%] -translate-x-1/2 z-[101] w-full max-w-xl"
                  onKeyDown={handleKeyDown}
                >
                  <Dialog.Title className="sr-only">Command Palette</Dialog.Title>

                  <div className="bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                    {/* Search input */}
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
                      <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search pages and actions..."
                        className="flex-1 bg-transparent text-white text-sm placeholder-slate-500 focus:outline-none"
                      />
                      <button
                        onClick={close}
                        className="flex-shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
                        aria-label="Close command palette"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Results */}
                    <div className="max-h-80 overflow-y-auto py-2">
                      {flatFiltered.length === 0 && (
                        <div className="px-4 py-8 text-center text-sm text-slate-500">
                          No results for &ldquo;{query}&rdquo;
                        </div>
                      )}

                      {groupedPages.length > 0 && (
                        <div>
                          <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                            Pages
                          </div>
                          {groupedPages.map((item) => {
                            const idx = flatFiltered.indexOf(item);
                            return (
                              <PaletteRow
                                key={item.id}
                                item={item}
                                isActive={activeIndex === idx}
                                onHover={() => setActiveIndex(idx)}
                              />
                            );
                          })}
                        </div>
                      )}

                      {groupedActions.length > 0 && (
                        <div>
                          <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                            Quick Actions
                          </div>
                          {groupedActions.map((item) => {
                            const idx = flatFiltered.indexOf(item);
                            return (
                              <PaletteRow
                                key={item.id}
                                item={item}
                                isActive={activeIndex === idx}
                                onHover={() => setActiveIndex(idx)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3 text-[10px] text-slate-600">
                      <span><kbd className="font-mono">↑↓</kbd> navigate</span>
                      <span><kbd className="font-mono">↵</kbd> select</span>
                      <span><kbd className="font-mono">Esc</kbd> close</span>
                    </div>
                  </div>
                </motion.div>
              </Dialog.Content>
            </>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteRow({
  item,
  isActive,
  onHover,
}: {
  item: PaletteItem;
  isActive: boolean;
  onHover: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={item.action}
      onMouseEnter={onHover}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
        isActive ? "bg-indigo-500/15 text-white" : "text-slate-300 hover:bg-white/5"
      )}
    >
      <div
        className={cn(
          "w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors",
          isActive ? "bg-indigo-500/30" : "bg-white/5"
        )}
      >
        <item.icon className={cn("w-3.5 h-3.5", isActive ? "text-indigo-400" : "text-slate-400")} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.label}</div>
        {item.description && (
          <div className="text-xs text-slate-500 truncate">{item.description}</div>
        )}
      </div>
    </motion.button>
  );
}
