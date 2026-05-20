"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, WifiOff, X } from "lucide-react";

const STORAGE_KEY = "infraweaver:offline-indicator";
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;

type OfflineBannerPrefs = {
  dismissedAt?: number;
  collapsedAt?: number;
};

function isFresh(timestamp?: number) {
  return typeof timestamp === "number" && Date.now() - timestamp < STORAGE_TTL_MS;
}

function readPrefs(): OfflineBannerPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as OfflineBannerPrefs;
    const next: OfflineBannerPrefs = {};
    if (isFresh(parsed.dismissedAt)) next.dismissedAt = parsed.dismissedAt;
    if (isFresh(parsed.collapsedAt)) next.collapsedAt = parsed.collapsedAt;
    if (JSON.stringify(parsed) !== JSON.stringify(next)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
    return next;
  } catch {
    return {};
  }
}

function writePrefs(next: OfflineBannerPrefs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

export function OfflineIndicator() {
  const initialPrefs = readPrefs();
  const [isOffline, setIsOffline] = useState(() => (typeof navigator !== "undefined" ? !navigator.onLine : false));
  const [dismissed, setDismissed] = useState(Boolean(initialPrefs.dismissedAt));
  const [collapsed, setCollapsed] = useState(Boolean(initialPrefs.collapsedAt));
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => {
      setIsOffline(false);
      setExpanded(false);
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const dismissBanner = () => {
    const next = { dismissedAt: Date.now() };
    writePrefs(next);
    setDismissed(true);
    setCollapsed(false);
    setExpanded(false);
  };

  const collapseBanner = () => {
    const next = { collapsedAt: Date.now() };
    writePrefs(next);
    setCollapsed(true);
    setExpanded(false);
  };

  const expandBanner = () => {
    writePrefs({});
    setCollapsed(false);
    setDismissed(false);
  };

  if (!isOffline || dismissed) return null;

  return (
    <AnimatePresence initial={false}>
      <motion.div
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -16, opacity: 0 }}
        className="fixed left-0 right-0 top-0 z-[500]"
      >
        {collapsed ? (
          <button
            type="button"
            onClick={expandBanner}
            className="block h-2 w-full bg-red-500/90 transition-colors hover:bg-red-400"
            aria-label="Expand offline banner"
            title="Expand offline banner"
          />
        ) : (
          <div className="border-b border-red-500/30 bg-red-600/95 text-gray-900 dark:text-white shadow-lg backdrop-blur-sm">
            <div className="mx-auto flex max-w-7xl items-start gap-3 px-3 py-2.5 sm:px-4">
              <WifiOff className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-5">Offline mode</p>
                <p
                  className={`mt-0.5 text-xs leading-5 text-red-50/90 ${expanded ? "" : "line-clamp-3 sm:line-clamp-none"}`}
                >
                  You&apos;re offline — live updates are paused, cached data may be stale, and any actions you take may need to be retried once the console reconnects.
                </p>
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-1 inline-flex min-h-[44px] items-center text-xs font-medium text-white/90 underline underline-offset-4 sm:hidden"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={collapseBanner}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-700 dark:text-white/80 transition-colors hover:bg-black/10 hover:text-gray-900 dark:hover:text-white"
                  aria-label="Collapse offline banner"
                  title="Collapse"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={dismissBanner}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-700 dark:text-white/80 transition-colors hover:bg-black/10 hover:text-gray-900 dark:hover:text-white"
                  aria-label="Dismiss offline banner"
                  title="Dismiss for 24 hours"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
