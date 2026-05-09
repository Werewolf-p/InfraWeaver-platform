"use client";
import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, Box, Activity, Network, Cog, HardDrive,
  FileText, Users, KeyRound, Terminal, History, Search, X,
} from "lucide-react";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard", shortcut: "G D" },
  { href: "/apps", icon: Box, label: "Applications", shortcut: "G A" },
  { href: "/health", icon: Activity, label: "Health", shortcut: "G H" },
  { href: "/network", icon: Network, label: "Network", shortcut: "G N" },
  { href: "/config", icon: Cog, label: "Config Editor", shortcut: "G C" },
  { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S" },
  { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L" },
  { href: "/users", icon: Users, label: "Users", shortcut: "G U" },
  { href: "/registry", icon: KeyRound, label: "Registry", shortcut: "G R" },
  { href: "/events", icon: History, label: "Activity Log", shortcut: "G E" },
  { href: "/exec", icon: Terminal, label: "Exec", shortcut: "G X" },
];

export function CommandPalette() {
  const { open, setOpen } = useCommandPaletteStore();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = navItems.filter(item =>
    item.label.toLowerCase().includes(query.toLowerCase())
  );

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
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

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
            <div className="max-h-80 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-slate-500 text-sm">No results found</div>
              ) : (
                filtered.map((item, i) => (
                  <button
                    key={item.href}
                    onClick={() => { router.push(item.href); setOpen(false); }}
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
                    <span className="text-xs text-slate-600 font-mono">{item.shortcut}</span>
                  </button>
                ))
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
