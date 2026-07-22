"use client";
import { useState, useEffect, useCallback } from "react";

export type RefreshInterval = 15000 | 30000 | 60000 | 300000;
export type Density = "compact" | "comfortable" | "spacious";

export interface AppSettings {
  refreshInterval: RefreshInterval;
  showSystemApps: boolean;
  density: Density;
}

const DEFAULT_SETTINGS: AppSettings = {
  refreshInterval: 30000,
  showSystemApps: true,
  density: "comfortable",
};

const STORAGE_KEY = "infraweaver-settings";

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with an external/browser store or dependency-driven reset; not derived render state
    setMounted(true);
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { settings, updateSetting, mounted };
}
