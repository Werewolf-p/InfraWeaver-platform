"use client";

import { useCallback } from "react";
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
