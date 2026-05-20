"use client";

import { useEffect } from "react";

export function useRefetchInterval(refetchFn: () => void | Promise<unknown>, intervalMs: number, enabled = true) {
  useEffect(() => {
    if (!enabled || intervalMs <= 0 || typeof window === "undefined") return;

    const tick = () => {
      if (document.visibilityState === "visible") {
        void refetchFn();
      }
    };

    const interval = window.setInterval(tick, intervalMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refetchFn();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs, refetchFn]);
}
