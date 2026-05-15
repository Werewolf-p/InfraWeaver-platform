"use client";
import { useMemo, useRef, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X, CheckCheck, Info, AlertTriangle, XCircle, CheckCircle, Trash2 } from "lucide-react";
import { useNotifications, type NotificationLevel } from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const levelConfig: Record<NotificationLevel, { icon: React.ElementType; color: string; bg: string }> = {
  info: { icon: Info, color: "text-blue-400", bg: "bg-blue-500/10" },
  warning: { icon: AlertTriangle, color: "text-yellow-400", bg: "bg-yellow-500/10" },
  error: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10" },
  success: { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/10" },
};

interface NotificationCenterProps {
  className?: string;
}

export function NotificationCenter({ className }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { notifications, unreadCount, markAllRead, markRead, dismiss, clearAll } = useNotifications();
  const counts = useMemo(() => ({
    warning: notifications.filter((notification) => notification.level === "warning" && !notification.read).length,
    error: notifications.filter((notification) => notification.level === "error" && !notification.read).length,
  }), [notifications]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className={cn("relative", className)} ref={panelRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 20 }}
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white",
                counts.error > 0 ? "bg-red-500" : "bg-amber-500"
              )}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full z-[100] mt-2 w-80 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Bell className="h-3.5 w-3.5 text-slate-400" />
                <h3 className="text-sm font-semibold text-white">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="rounded-full border border-indigo-500/30 bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-400">
                    {unreadCount} open
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button onClick={markAllRead} className="flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300">
                    <CheckCheck className="h-3 w-3" />
                    Read all
                  </button>
                )}
                {notifications.length > 0 && (
                  <button onClick={clearAll} className="flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300">
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="text-slate-500 transition-colors hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {(counts.warning > 0 || counts.error > 0) && (
              <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2 text-[11px] text-slate-400">
                {counts.error > 0 ? <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-red-300">{counts.error} errors</span> : null}
                {counts.warning > 0 ? <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-yellow-300">{counts.warning} warnings</span> : null}
              </div>
            )}

            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="py-10 text-center">
                  <Bell className="mx-auto mb-2 h-6 w-6 text-slate-700" />
                  <p className="text-sm text-slate-600">No notifications yet</p>
                  <p className="mt-1 text-[11px] text-slate-700">Cluster warnings and operator notices will appear here.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {notifications.map((notification) => {
                    const config = levelConfig[notification.level];
                    const Icon = config.icon;
                    return (
                      <motion.div
                        key={notification.id}
                        layout
                        initial={{ opacity: 0, x: -4 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 4 }}
                        className={cn(
                          "flex cursor-default gap-3 px-4 py-3 transition-colors hover:bg-white/5",
                          !notification.read && "bg-white/[0.02]"
                        )}
                        onClick={() => markRead(notification.id)}
                      >
                        <div className={cn("mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg", config.bg)}>
                          <Icon className={cn("h-3.5 w-3.5", config.color)} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-sm font-medium", notification.read ? "text-slate-400" : "text-white")}>
                              {notification.title}
                            </p>
                            <button
                              onClick={(e) => { e.stopPropagation(); dismiss(notification.id); }}
                              className="mt-0.5 flex-shrink-0 text-slate-600 transition-colors hover:text-slate-400"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          {notification.body && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{notification.body}</p>}
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-[10px] text-slate-600">{formatRelativeTime(notification.timestamp)}</span>
                            {!notification.read && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-500" />}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
