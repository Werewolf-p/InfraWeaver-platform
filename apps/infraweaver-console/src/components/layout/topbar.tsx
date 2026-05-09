"use client";
import { useState } from "react";
import { Bell, LogOut, Menu, Command } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import { useArgoApps } from "@/hooks/use-argocd";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { cn } from "@/lib/utils";

interface TopBarProps {
  title?: string;
  onMenuOpen?: () => void;
}

function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { data: apps } = useArgoApps();
  const degraded = (apps ?? []).filter(a => a.status.health.status === "Degraded");
  const outOfSync = (apps ?? []).filter(a => a.status.sync.status === "OutOfSync");

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ type: "spring", damping: 30, stiffness: 400 }}
      className="absolute right-0 top-12 w-80 bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-white/5">
        <h3 className="text-sm font-semibold text-white">Notifications</h3>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {degraded.length === 0 && outOfSync.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            All systems operational ✓
          </div>
        ) : (
          <div className="py-2">
            {degraded.map(app => (
              <div key={app.metadata.name} className="px-4 py-2.5 hover:bg-white/5 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <span className="text-sm text-white font-medium truncate">{app.metadata.name}</span>
                </div>
                <p className="text-xs text-red-400 mt-0.5 ml-4">Health: Degraded</p>
              </div>
            ))}
            {outOfSync.map(app => (
              <div key={`oos-${app.metadata.name}`} className="px-4 py-2.5 hover:bg-white/5 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" />
                  <span className="text-sm text-white font-medium truncate">{app.metadata.name}</span>
                </div>
                <p className="text-xs text-orange-400 mt-0.5 ml-4">Sync: OutOfSync</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function TopBar({ title, onMenuOpen }: TopBarProps) {
  const { data: session } = useSession();
  const { data: apps } = useArgoApps();
  const { open: openPalette } = useCommandPaletteStore();
  const [notifOpen, setNotifOpen] = useState(false);

  const alertCount = (apps ?? []).filter(
    a => a.status.health.status === "Degraded" || a.status.sync.status === "OutOfSync"
  ).length;

  return (
    <header className="h-14 border-b border-white/5 bg-slate-950/80 backdrop-blur-sm flex items-center justify-between px-4 md:px-6 flex-shrink-0">
      <div className="flex items-center gap-3">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuOpen}
          className="md:hidden w-8 h-8 rounded-lg bg-white/5 border border-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-sm font-semibold text-white">{title ?? "InfraWeaver Console"}</h1>
          <p className="text-xs text-slate-500 hidden sm:block">platform.int.rlservers.com</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* ⌘K command palette button */}
        <motion.button
          whileTap={{ scale: 0.93 }}
          onClick={openPalette}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/8 text-slate-400 hover:text-white hover:bg-white/8 transition-colors text-xs"
          aria-label="Open command palette"
        >
          <Command className="w-3 h-3" />
          <span>K</span>
        </motion.button>

        {/* Notification bell */}
        <div className="relative">
          <motion.button
            whileTap={{ scale: 0.93 }}
            onClick={() => setNotifOpen(v => !v)}
            className={cn(
              "w-8 h-8 rounded-lg border flex items-center justify-center transition-colors relative",
              notifOpen
                ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300"
                : "bg-white/5 border-white/5 text-slate-400 hover:text-white"
            )}
            aria-label="Notifications"
          >
            <Bell className="w-4 h-4" />
            {alertCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center">
                {alertCount > 9 ? "9+" : alertCount}
              </span>
            )}
          </motion.button>
          <AnimatePresence>
            {notifOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setNotifOpen(false)}
                />
                <NotificationPanel onClose={() => setNotifOpen(false)} />
              </>
            )}
          </AnimatePresence>
        </div>

        {/* User */}
        <div className="flex items-center gap-2 pl-2 border-l border-white/10">
          <div className="w-7 h-7 rounded-full bg-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300">
            {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <span className="text-xs text-slate-300 hidden sm:block">{session?.user?.name}</span>
          <button
            onClick={() => signOut()}
            className="ml-1 text-slate-500 hover:text-slate-300 transition-colors"
            aria-label="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
