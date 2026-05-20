"use client";

import { useCallback } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useServerPreferences } from "@/hooks/use-server-preferences";
import type { DashboardLayoutPreferences } from "@/lib/user-preferences";

export type UserPreferences = DashboardLayoutPreferences;

export function useUserPreferences() {
  const { preferences, setPreferences, isLoading } = useServerPreferences();
  const prefs = preferences.dashboardLayout;

  const setPreference = useCallback(<K extends keyof DashboardLayoutPreferences>(
    key: K,
    value: DashboardLayoutPreferences[K]
  ) => {
    setPreferences({
      dashboardLayout: { [key]: value } as Partial<DashboardLayoutPreferences>,
    });
  }, [setPreferences]);

  const toggleWidget = useCallback((id: string) => {
    setPreferences((current) => ({
      dashboardLayout: {
        widgets: {
          ...current.dashboardLayout.widgets,
          [id]: !current.dashboardLayout.widgets[id],
        },
      },
    }));
  }, [setPreferences]);

  return { prefs, setPreference, toggleWidget, isLoading };
}

interface SimplePreferences {
  tablePageSize: number;
  sidebarCollapsed: boolean;
  defaultNamespace: string;
  refreshInterval: number;
}

export function useUserPreference<K extends keyof SimplePreferences>(
  key: K,
  defaultValue: SimplePreferences[K]
): [SimplePreferences[K], (value: SimplePreferences[K]) => void] {
  const storageKey = `infraweaver:${String(key)}`;
  const [value, setValue] = useLocalStorage<SimplePreferences[K]>(storageKey, defaultValue);

  const updateValue = useCallback((nextValue: SimplePreferences[K]) => {
    setValue(nextValue);
  }, [setValue]);

  return [value, updateValue];
}
