"use client";
import { useState, useCallback } from "react";
import { Bell, X, CheckCheck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export type NotificationLevel = "info" | "warning" | "error" | "success";

export interface Notification {
  id: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  timestamp: Date;
  read: boolean;
}

const levelStyles: Record<NotificationLevel, string> = {
  info: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  warning: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  error: "border-red-500/40 bg-red-500/10 text-red-400",
  success: "border-green-500/40 bg-green-500/10 text-green-400",
};

let _addNotification: ((n: Omit<Notification, "id" | "timestamp" | "read">) => void) | null = null;

export function pushNotification(n: Omit<Notification, "id" | "timestamp" | "read">) {
  _addNotification?.(n);
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const add = useCallback((n: Omit<Notification, "id" | "timestamp" | "read">) => {
    const entry: Notification = { ...n, id: crypto.randomUUID(), timestamp: new Date(), read: false };
    setNotifications(prev => [entry, ...prev].slice(0, 50));
  }, []);

  _addNotification = add;

  const markAllRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  return { notifications, add, markAllRead, dismiss, unreadCount };
}

interface NotificationCenterProps {
  className?: string;
}

export function NotificationCenter({ className }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const { notifications, markAllRead, dismiss, unreadCount } = useNotifications();

  return (
    <div className={cn("relative", className)}>
      <button
        onClick={() => { setOpen(o => !o); if (!open) markAllRead(); }}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/10 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4 text-white/70" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-11 z-40 w-80 rounded-xl border border-white/10 bg-neutral-900 shadow-2xl"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <span className="text-sm font-semibold text-white">Notifications</span>
                <button onClick={markAllRead} className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1">
                  <CheckCheck className="w-3 h-3" /> Mark all read
                </button>
              </div>
              <div className="max-h-96 overflow-y-auto divide-y divide-white/5">
                {notifications.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-white/30">No notifications</p>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} className={cn("px-4 py-3 flex gap-3", !n.read && "bg-white/5")}>
                      <div className={cn("flex-1 min-w-0 rounded-md border px-2 py-1.5", levelStyles[n.level])}>
                        <p className="text-xs font-medium">{n.title}</p>
                        {n.body && <p className="text-xs opacity-70 mt-0.5">{n.body}</p>}
                        <p className="text-[10px] opacity-50 mt-1">{n.timestamp.toLocaleTimeString()}</p>
                      </div>
                      <button onClick={() => dismiss(n.id)} className="shrink-0 text-white/30 hover:text-white/60">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
