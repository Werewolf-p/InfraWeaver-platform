"use client";
import { Menu, Search } from "lucide-react";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { NotificationCenter } from "@/components/ui/notification-center";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useSession } from "next-auth/react";

export function TopBar({ title, onMenuClick }: { title?: string; onMenuClick?: () => void }) {
  const { data: session } = useSession();
  const setOpen = useCommandPaletteStore(s => s.setOpen);

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
        {/* Inline search — clicking opens command palette */}
        <button
          onClick={() => setOpen(true)}
          className="hidden md:flex items-center gap-2 flex-1 max-w-sm px-3 py-1.5 bg-[#0f0f0f] border border-[#333] rounded text-sm text-[#666] hover:border-[#555] hover:text-[#9e9e9e] transition-colors"
        >
          <Search className="w-3.5 h-3.5" />
          <span>Search resources...</span>
          <span className="ml-auto text-xs font-mono opacity-60">⌘K</span>
        </button>
      </div>
      <div className="flex items-center gap-2">
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
