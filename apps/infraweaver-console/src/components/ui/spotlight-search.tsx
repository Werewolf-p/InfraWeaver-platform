"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, Clock, Box, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useResourceSearch } from "@/hooks/use-resource-search";
import { ALL_NAV_ITEMS } from "@/lib/nav-config";

const RECENT_KEY = "infraweaver:spotlight-recent";
const MAX_RECENT = 5;

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}

function saveRecent(q: string) {
  if (!q.trim()) return;
  try {
    const prev = loadRecent();
    const next = [q, ...prev.filter(x => x !== q)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

interface SpotlightSearchProps {
  open: boolean;
  onClose: () => void;
}

export function SpotlightSearch({ open, onClose }: SpotlightSearchProps) {
  const [query, setQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { results, loading } = useResourceSearch(query);

  useEffect(() => {
    if (open) {
      setRecentSearches(loadRecent());
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const navResults = ALL_NAV_ITEMS.filter(item =>
    query.trim() && item.label.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 5);

  const handleNavigate = (href: string) => {
    if (query.trim()) saveRecent(query.trim());
    router.push(href);
    onClose();
  };

  const handleRecentClick = (q: string) => {
    setQuery(q);
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[400] bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -20, opacity: 0 }}
            transition={{ type: "spring", damping: 30, stiffness: 400 }}
            className="fixed top-4 left-4 right-4 z-[401] md:left-1/2 md:-translate-x-1/2 md:max-w-2xl md:w-full"
          >
            <div className="bg-[#1a1a1a] border border-[#333] rounded-2xl shadow-2xl overflow-hidden">
              {/* Search input */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[#2a2a2a]">
                <Search className="w-5 h-5 text-[#555] flex-shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search apps, pods, pages…"
                  className="flex-1 bg-transparent text-[#f2f2f2] placeholder:text-[#555] text-sm outline-none"
                />
                {query && (
                  <button onClick={() => setQuery("")} className="text-[#555] hover:text-[#9e9e9e]">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="max-h-[70vh] overflow-y-auto">
                {/* Recent searches */}
                {!query && recentSearches.length > 0 && (
                  <div className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#555] mb-2 px-1">Recent</p>
                    {recentSearches.map(q => (
                      <button
                        key={q}
                        onClick={() => handleRecentClick(q)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#9e9e9e] hover:bg-[#2a2a2a] hover:text-white transition-colors"
                      >
                        <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                        {q}
                      </button>
                    ))}
                  </div>
                )}

                {/* Nav results */}
                {navResults.length > 0 && (
                  <div className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#555] mb-2 px-1">Pages</p>
                    {navResults.map(item => (
                      <button
                        key={item.href}
                        onClick={() => handleNavigate(item.href)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#9e9e9e] hover:bg-[#2a2a2a] hover:text-white transition-colors"
                      >
                        <item.icon className="w-4 h-4 flex-shrink-0 text-[#0078D4]" />
                        <div className="text-left">
                          <p className="text-[#f2f2f2] text-sm">{item.label}</p>
                          {item.description && <p className="text-[10px] text-[#555]">{item.description}</p>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Resource results */}
                {query && results.length > 0 && (
                  <div className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#555] mb-2 px-1">Resources</p>
                    {results.map(r => (
                      <button
                        key={r.id}
                        onClick={() => handleNavigate(r.href)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#9e9e9e] hover:bg-[#2a2a2a] hover:text-white transition-colors"
                      >
                        {r.type === "app" ? <Box className="w-4 h-4 flex-shrink-0 text-indigo-400" /> : <Server className="w-4 h-4 flex-shrink-0 text-blue-400" />}
                        <div className="text-left">
                          <p className="text-[#f2f2f2] text-sm">{r.name}</p>
                          <p className="text-[10px] text-[#555]">{r.subtitle}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {query && !loading && results.length === 0 && navResults.length === 0 && (
                  <div className="p-8 text-center text-[#555] text-sm">
                    No results for &ldquo;{query}&rdquo;
                  </div>
                )}

                {loading && (
                  <div className="p-4 text-center text-[#555] text-sm">Searching…</div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
