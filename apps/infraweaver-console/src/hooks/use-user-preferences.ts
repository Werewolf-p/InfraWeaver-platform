"use client";
import { useState, useEffect, useCallback } from "react";

interface UserPreferences {
  widgets: Record<string, boolean>;
  navSections: Record<string, boolean>;
  density: "compact" | "comfortable";
  startPage: string;
}

const DEFAULTS: UserPreferences = {
  widgets: {
    "platform-services": true,
    "recent-activity": true,
    "resource-usage": true,
    "quick-links": true,
  },
  navSections: {},
  density: "comfortable",
  startPage: "/home",
};

const KEY = "infraweaver_prefs";

export function useUserPreferences() {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULTS);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) setPrefs(prev => ({ ...prev, ...JSON.parse(stored) }));
    } catch { /* ignore */ }
  }, []);

  const setPreference = useCallback(<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => {
    setPrefs(prev => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleWidget = useCallback((id: string) => {
    setPrefs(prev => {
      const next = { ...prev, widgets: { ...prev.widgets, [id]: !prev.widgets[id] } };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { prefs, setPreference, toggleWidget };
}
