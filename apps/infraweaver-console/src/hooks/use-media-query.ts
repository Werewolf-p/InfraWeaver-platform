"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query. Uses useSyncExternalStore so the value is
 * read from the browser's matchMedia store directly (no setState-in-effect) and
 * renders SSR-safe (server snapshot is always false, matching first client paint).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = () =>
    typeof window !== "undefined" && window.matchMedia(query).matches;
  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
