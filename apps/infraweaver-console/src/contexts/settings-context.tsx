"use client";
import { createContext, useContext, type ReactNode } from "react";
import { useSettings, type AppSettings, type RefreshInterval, type Density } from "@/hooks/use-settings";

interface SettingsContextValue {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  mounted: boolean;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { refreshInterval: 30000, compactMode: false, showSystemApps: true, density: "comfortable" },
  updateSetting: () => {},
  mounted: false,
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const settingsState = useSettings();
  return (
    <SettingsContext.Provider value={settingsState}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettingsContext() {
  return useContext(SettingsContext);
}

export type { AppSettings, RefreshInterval, Density };
