"use client";
import { Bell, LogOut, Menu } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

export function TopBar({ title, onMenuClick }: { title?: string; onMenuClick?: () => void }) {
  const { data: session } = useSession();
  const setOpen = useCommandPaletteStore(s => s.setOpen);

  return (
    <header className="h-14 border-b border-white/5 bg-slate-950/80 backdrop-blur-sm flex items-center justify-between px-4 md:px-6 flex-shrink-0">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="md:hidden w-8 h-8 rounded-lg bg-white/5 border border-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-sm font-semibold text-white">{title ?? "InfraWeaver Console"}</h1>
          <p className="text-xs text-slate-500">infraweaver.int.rlservers.com</p>
        </div>
      </div>
      <div className="flex items-center gap-2 md:gap-3">
        <button
          onClick={() => setOpen(true)}
          className="hidden md:flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 bg-slate-800/50 border border-slate-700/50 rounded-lg hover:bg-slate-700/50 transition-colors"
        >
          <span>⌘K</span>
        </button>
        <button className="w-8 h-8 rounded-lg bg-white/5 border border-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-colors">
          <Bell className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 pl-3 border-l border-white/10">
          <div className="w-7 h-7 rounded-full bg-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300">
            {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <span className="hidden md:block text-xs text-slate-300">{session?.user?.name}</span>
          <button
            onClick={() => signOut()}
            className="ml-1 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
