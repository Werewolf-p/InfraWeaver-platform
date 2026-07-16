"use client";
import { useMemo, useRef, useState, useEffect } from "react";
import { motion, AnimatePresence, useAnimation } from "framer-motion";
import { Bell, X, CheckCheck, Info, AlertTriangle, XCircle, CheckCircle, Trash2 } from "lucide-react";
import { useNotifications, type NotificationLevel } from "@/hooks/use-notifications";
import { cn, timeAgo } from "@/lib/utils";
import { useMotionSafe } from "@/lib/spring";

const levelConfig: Record<NotificationLevel, { icon: React.ElementType; color: string; bg: string }> = {
  info: { icon: Info, color: "text-blue-400", bg: "bg-blue-500/10" },
  warning: { icon: AlertTriangle, color: "text-yellow-400", bg: "bg-yellow-500/10" },
  error: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10" },
  success: { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/10" },
};

// Bell ring sequence: simulate a physical bell swing
const RING_KEYFRAMES = [0, -20, 16, -12, 8, -5, 3, 0];

interface NotificationCenterProps {
  className?: string;
}

export function NotificationCenter({ className }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const bellControls = useAnimation();
  const motionSafe = useMotionSafe();
  const prevUnreadRef = useRef<number | null>(null);
  const { notifications, unreadCount, markAllRead, markRead, dismiss, clearAll } = useNotifications();
  const counts = useMemo(() => ({
    warning: notifications.filter((n) => n.level === "warning" && !n.read).length,
    error: notifications.filter((n) => n.level === "error" && !n.read).length,
  }), [notifications]);

  // Ring the bell when unread count increases (new notification arrived)
  useEffect(() => {
    if (prevUnreadRef.current !== null && unreadCount > prevUnreadRef.current && !open) {
      if (!motionSafe.reduced) {
        void bellControls.start({
          rotate: RING_KEYFRAMES,
          transition: { duration: 0.7, ease: "easeInOut" },
        });
      }
      setLiveMessage(`New notification. ${unreadCount} unread.`);
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount, open, bellControls, motionSafe.reduced]);

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

  const bellLabel = unreadCount > 0
    ? `Notifications, ${unreadCount} unread`
    : "Notifications, all read";

  return (
    <div className={cn("relative", className)} ref={panelRef}>
      {/* Polite live region — announces new notifications to screen readers without interrupting */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>

      <button
        onClick={() => setOpen((prev) => !prev)}
        className="relative touch-target flex items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
        aria-label={bellLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <motion.span animate={bellControls} style={{ display: "inline-flex", transformOrigin: "50% 0%" }}>
          <Bell aria-hidden="true" className="h-4 w-4" />
        </motion.span>
        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.span
              key={unreadCount}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 20 }}
              aria-hidden="true"
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-gray-900 dark:text-white",
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
            transition={motionSafe.transition({ duration: 0.15, ease: "easeOut" })}
            role="dialog"
            aria-label="Notifications"
            className="absolute right-0 top-full z-toast mt-2 w-80 overflow-hidden rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Bell aria-hidden="true" className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="rounded-full border border-indigo-500/30 bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-400">
                    {unreadCount} open
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    aria-label="Mark all notifications as read"
                    className="flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-700 dark:hover:text-slate-300"
                  >
                    <CheckCheck aria-hidden="true" className="h-3 w-3" />
                    Read all
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={clearAll}
                    aria-label="Clear all notifications"
                    className="flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-700 dark:hover:text-slate-300"
                  >
                    <Trash2 aria-hidden="true" className="h-3 w-3" />
                    Clear
                  </button>
                )}
                <button onClick={() => setOpen(false)} aria-label="Close notifications" className="text-slate-500 transition-colors hover:text-gray-900 dark:hover:text-white">
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </div>

            {(counts.warning > 0 || counts.error > 0) && (
              <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/5 px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400">
                {counts.error > 0 ? <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-red-300">{counts.error} errors</span> : null}
                {counts.warning > 0 ? <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-yellow-300">{counts.warning} warnings</span> : null}
              </div>
            )}

            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="py-10 text-center">
                  <Bell aria-hidden="true" className="mx-auto mb-2 h-6 w-6 text-slate-700" />
                  <p className="text-sm text-slate-600">No notifications yet</p>
                  <p className="mt-1 text-[11px] text-slate-700">Errors, warnings and notices will appear here.</p>
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
                        role="button"
                        tabIndex={0}
                        aria-label={`Mark as read: ${notification.title ?? "notification"}`}
                        initial={{ opacity: 0, x: -4 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 4 }}
                        className={cn(
                          "flex cursor-pointer gap-3 px-4 py-3 transition-colors hover:bg-gray-100 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50",
                          !notification.read && "bg-gray-50 dark:bg-white/[0.02]"
                        )}
                        onClick={() => markRead(notification.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            markRead(notification.id);
                          }
                        }}
                      >
                        <div className={cn("mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg", config.bg)}>
                          <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", config.color)} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium leading-snug", notification.read ? "text-slate-500 dark:text-slate-400" : "text-gray-900 dark:text-white")}>
                              <span className="truncate">{notification.title}</span>
                              {notification.count && notification.count > 1 ? (
                                <span
                                  aria-label={`${notification.count} occurrences`}
                                  className="flex-shrink-0 rounded-full border border-slate-400/40 bg-slate-500/10 px-1.5 text-[10px] font-semibold tabular-nums text-slate-500 dark:text-slate-300"
                                >
                                  ×{notification.count > 99 ? "99+" : notification.count}
                                </span>
                              ) : null}
                            </p>
                            <button
                              onClick={(e) => { e.stopPropagation(); dismiss(notification.id); }}
                              aria-label={`Dismiss: ${notification.title ?? "notification"}`}
                              className="mt-0.5 flex-shrink-0 text-slate-600 transition-colors hover:text-slate-700 dark:hover:text-slate-400"
                            >
                              <X aria-hidden="true" className="h-3 w-3" />
                            </button>
                          </div>
                          {notification.body && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{notification.body}</p>}
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-[10px] text-slate-600">{timeAgo(new Date(notification.timestamp))}</span>
                            {(notification.app || notification.cause) && (
                              <span className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                                {[notification.app, notification.cause].filter(Boolean).join(" · ")}
                              </span>
                            )}
                            {!notification.read && <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-500" />}
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

