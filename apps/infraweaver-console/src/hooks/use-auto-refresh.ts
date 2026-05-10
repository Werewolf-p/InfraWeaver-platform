"use client";
import { useEffect, useRef, useCallback } from "react";

interface AutoRefreshOptions {
  interval: number;
  onRefresh: () => void | Promise<void>;
  enabled?: boolean;
}

export function useAutoRefresh({ interval, onRefresh, enabled = true }: AutoRefreshOptions) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const start = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (interval > 0) {
      timerRef.current = setInterval(() => {
        void onRefreshRef.current();
      }, interval);
    }
  }, [interval]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (enabled && interval > 0) {
      start();
    } else {
      stop();
    }
    return stop;
  }, [enabled, interval, start, stop]);

  return { start, stop };
}
