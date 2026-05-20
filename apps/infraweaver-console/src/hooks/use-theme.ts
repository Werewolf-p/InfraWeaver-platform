"use client";

import { useCallback, useEffect } from "react";
import { useServerPreferences } from "@/hooks/use-server-preferences";
import type { ThemePreference } from "@/lib/user-preferences";

export type Theme = ThemePreference;

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ThemePreference) {
  if (typeof document === "undefined") return;
  const resolved = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);
  try {
    localStorage.setItem("theme", theme);
    localStorage.setItem("iw-theme", theme);
  } catch {
    // Ignore unavailable storage.
  }
}

export function useTheme() {
  const { preferences, setPreferences } = useServerPreferences();
  const theme = preferences.theme;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");

    media.addEventListener?.("change", handleChange);
    media.addListener?.(handleChange);
    return () => {
      media.removeEventListener?.("change", handleChange);
      media.removeListener?.(handleChange);
    };
  }, [theme]);

  const setTheme = useCallback((nextTheme: ThemePreference) => {
    applyTheme(nextTheme);
    setPreferences({ theme: nextTheme });
  }, [setPreferences]);

  const resolvedTheme = theme === "system" ? getSystemTheme() : theme;

  return { theme, setTheme, resolvedTheme };
}
