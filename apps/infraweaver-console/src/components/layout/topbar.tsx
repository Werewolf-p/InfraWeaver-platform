"use client";
import { Menu, Search, Plus, ExternalLink } from "lucide-react";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { NotificationCenter } from "@/components/ui/notification-center";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useSession } from "next-auth/react";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";

const QUICK_CREATE_ITEMS = [
  { label: "Deploy from Catalog", href: "/catalog-install" },
  { label: "Community App", href: "/community-apps" },
  { label: "Add Port Route", href: "/gameservers" },
];

export function TopBar({ title: _title, onMenuClick, onSearchClick }: { title?: string; onMenuClick?: () => void; onSearchClick?: () => void }) {
  const { data: session } = useSession();
  const setOpen = useCommandPaletteStore(s => s.setOpen);
  const [quickOpen, setQuickOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setQuickOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <header className="h-12 border-b border-[#2a2a2a] bg-[#141414] flex items-center justify-between px-4 flex-shrink-0">
      <div className="flex items-center gap-3 flex-1">
        <button
          onClick={onMenuClick}
          className="md:hidden w-8 h-8 rounded flex items-center justify-center text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#2a2a2a] transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <button
          onClick={onSearchClick}
          className="md:hidden w-8 h-8 rounded flex items-center justify-center text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#2a2a2a] transition-colors"
          aria-label="Search"
        >
          <Search className="w-4 h-4" />
        </button>
        {/* Inline search — clicking opens command palette */}
        <button
          onClick={() => setOpen(true)}
          className="hidden md:flex items-center gap-2 flex-1 max-w-md px-3 py-1.5 bg-[#0f0f0f] border border-[#333] rounded text-sm text-[#666] hover:border-[#555] hover:text-[#9e9e9e] transition-colors"
        >
          <Search className="w-3.5 h-3.5" />
          <span>Search resources...</span>
          <span className="ml-auto text-xs font-mono opacity-60">⌘K</span>
        </button>
      </div>
      <div className="flex items-center gap-2">
        {/* Quick Create */}
        <div className="relative" ref={dropRef}>
          <button
            onClick={() => setQuickOpen(v => !v)}
            className="hidden md:flex items-center gap-1 px-2 py-1.5 bg-[#0078D4] hover:bg-[#1a86d9] text-white text-xs rounded transition-colors"
            title="Quick create"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {quickOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl z-50 py-1">
              {QUICK_CREATE_ITEMS.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setQuickOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-[#f2f2f2] hover:bg-[#2a2a2a] transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-[#555]" />
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </div>
        <ThemeToggle compact />
        <NotificationCenter />
        <div className="flex items-center gap-2 pl-3 border-l border-[#2a2a2a]">
          <div className="w-7 h-7 rounded-full bg-[#0078D4] flex items-center justify-center text-xs font-bold text-white">
            {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <span className="hidden md:block text-xs text-[#9e9e9e]">{session?.user?.name}</span>
        </div>
      </div>
    </header>
  );
}

