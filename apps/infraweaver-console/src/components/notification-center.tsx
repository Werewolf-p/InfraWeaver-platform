"use client";
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence, useAnimation } from "framer-motion";
import { Bell, X, CheckCheck, Info, AlertTriangle, XCircle, CheckCircle } from "lucide-react";
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

const RING_KEYFRAMES = [0, -20, 16, -12, 8, -5, 3, 0];

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const bellControls = useAnimation();
  const prevUnreadRef = useRef<number | null>(null);
  const { notifications, unreadCount, markAllRead, markRead, dismiss } = useNotifications();

  useEffect(() => {
    if (prevUnreadRef.current !== null && unreadCount > prevUnreadRef.current && !open) {
      void bellControls.start({
        rotate: RING_KEYFRAMES,
        transition: { duration: 0.7, ease: "easeInOut" },
      });
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount, open, bellControls]);

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
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(prev => !prev)}
        className="relative p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        aria-label="Notifications"
      >
        <motion.span animate={bellControls} style={{ display: "inline-flex", transformOrigin: "50% 0%" }}>
          <Bell className="w-4 h-4" />
        </motion.span>
        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.span
              key={unreadCount}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 20 }}
              className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full mt-2 w-80 bg-slate-100 dark:bg-slate-900/95 backdrop-blur-xl border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden z-[100]"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-white/10">
              <div className="flex items-center gap-2">
                <Bell className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="text-[10px] bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-full px-1.5 py-0.5">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors flex items-center gap-1"
                  >
                    <CheckCheck className="w-3 h-3" />
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="text-slate-500 hover:text-gray-900 dark:hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Notification list */}
            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="py-10 text-center">
                  <Bell className="w-6 h-6 text-slate-700 mx-auto mb-2" />
                  <p className="text-sm text-slate-600">No notifications</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {notifications.map(notification => {
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
                          "flex gap-3 px-4 py-3 transition-colors hover:bg-gray-100 dark:hover:bg-white/5 cursor-default",
                          !notification.read && "bg-gray-50 dark:bg-white/[0.02]"
                        )}
                        onClick={() => markRead(notification.id)}
                      >
                        <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5", config.bg)}>
                          <Icon className={cn("w-3.5 h-3.5", config.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-sm font-medium", notification.read ? "text-slate-500 dark:text-slate-400" : "text-gray-900 dark:text-white")}>
                              {notification.title}
                            </p>
                            <button
                              onClick={e => { e.stopPropagation(); dismiss(notification.id); }}
                              className="text-slate-600 hover:text-slate-700 dark:hover:text-slate-400 transition-colors flex-shrink-0 mt-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                          {notification.body && (
                            <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{notification.body}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-slate-600">{formatRelativeTime(notification.timestamp)}</span>
                            {!notification.read && (
                              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
                            )}
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
