"use client";

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  DEFAULT_USER_PREFERENCES,
  USER_PREFERENCES_QUERY_KEY,
  USER_PREFERENCES_STORAGE_KEYS,
  mergeDashboardLayout,
  mergeUserPreferences,
  normalizePinnedApps,
  normalizeRecentSearches,
  normalizeRecentlyVisited,
  normalizeUserPreferences,
  isThemePreference,
  type ThemePreference,
  type UserPreferencesPayload,
  type UserPreferencesUpdate,
} from "@/lib/user-preferences";

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let latestPreferences: UserPreferencesPayload | null = null;

function readStoredJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function loadDashboardLayoutFromStorage() {
  return mergeDashboardLayout(
    DEFAULT_DASHBOARD_LAYOUT,
    readStoredJson<UserPreferencesPayload["dashboardLayout"]>(USER_PREFERENCES_STORAGE_KEYS.dashboardLayout) ?? undefined
  );
}

function loadPinnedAppsFromStorage() {
  const stored = readStoredJson<Array<string | { href?: string }>>(USER_PREFERENCES_STORAGE_KEYS.pinnedApps);
  if (!Array.isArray(stored)) return DEFAULT_USER_PREFERENCES.pinnedApps;
  return normalizePinnedApps(stored.map((entry) => typeof entry === "string" ? entry : entry?.href ?? ""));
}

function loadThemeFromStorage(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_USER_PREFERENCES.theme;
  const stored = localStorage.getItem(USER_PREFERENCES_STORAGE_KEYS.theme)
    ?? localStorage.getItem(USER_PREFERENCES_STORAGE_KEYS.legacyTheme);
  return isThemePreference(stored) ? stored : DEFAULT_USER_PREFERENCES.theme;
}

export function loadLocalUserPreferences(): UserPreferencesPayload {
  return normalizeUserPreferences({
    dashboardLayout: loadDashboardLayoutFromStorage(),
    pinnedApps: loadPinnedAppsFromStorage(),
    theme: loadThemeFromStorage(),
    recentlyVisited: normalizeRecentlyVisited(
      readStoredJson(USER_PREFERENCES_STORAGE_KEYS.recentlyVisited) ?? DEFAULT_USER_PREFERENCES.recentlyVisited
    ),
    recentSearches: normalizeRecentSearches(
      readStoredJson(USER_PREFERENCES_STORAGE_KEYS.recentSearches) ?? DEFAULT_USER_PREFERENCES.recentSearches
    ),
  });
}

export function persistLocalUserPreferences(preferences: UserPreferencesPayload) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEYS.dashboardLayout,
      JSON.stringify(preferences.dashboardLayout)
    );
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEYS.pinnedApps,
      JSON.stringify(preferences.pinnedApps)
    );
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEYS.recentlyVisited,
      JSON.stringify(preferences.recentlyVisited)
    );
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEYS.recentSearches,
      JSON.stringify(preferences.recentSearches)
    );
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEYS.theme, preferences.theme);
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEYS.legacyTheme, preferences.theme);
  } catch {
    // LocalStorage is best-effort only.
  }
}

async function fetchServerPreferences() {
  const res = await fetch("/api/user/preferences", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`Failed to load preferences: ${res.status}`);
  }
  return normalizeUserPreferences(await res.json());
}

function sendPreferences(snapshot: UserPreferencesPayload, keepalive = false) {
  // keepalive lets the request outlive a page that is unloading, so a setting
  // changed right before navigating away or closing the tab still persists.
  return fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
    keepalive,
  });
}

function schedulePreferencesSave(preferences: UserPreferencesPayload) {
  if (typeof window === "undefined") return;
  latestPreferences = preferences;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const snapshot = latestPreferences;
    saveTimer = null;
    if (!snapshot) return;
    try {
      await sendPreferences(snapshot);
    } catch {
      // Keep the local fallback; the next successful save will reconcile.
    }
  }, 2000);
}

// Flush any pending debounced save immediately — used when the page is being
// hidden/unloaded so the 2s debounce can't swallow the last change.
function flushPreferencesSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = latestPreferences;
  if (!snapshot) return;
  try {
    void sendPreferences(snapshot, true).catch(() => { /* best-effort on unload */ });
  } catch {
    // Ignore — localStorage already holds the change for the next session.
  }
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPreferencesSave();
  });
  window.addEventListener("pagehide", flushPreferencesSave);
}

type PreferencesUpdater = UserPreferencesUpdate | ((current: UserPreferencesPayload) => UserPreferencesUpdate);

export function useServerPreferences() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: USER_PREFERENCES_QUERY_KEY,
    queryFn: fetchServerPreferences,
    initialData: loadLocalUserPreferences,
    initialDataUpdatedAt: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    persistLocalUserPreferences(query.data ?? DEFAULT_USER_PREFERENCES);
  }, [query.data]);

  const setPreferences = useCallback((updateOrUpdater: PreferencesUpdater) => {
    queryClient.setQueryData<UserPreferencesPayload>(USER_PREFERENCES_QUERY_KEY, (current) => {
      const base = current ?? loadLocalUserPreferences();
      const update = typeof updateOrUpdater === "function" ? updateOrUpdater(base) : updateOrUpdater;
      const next = mergeUserPreferences(base, update);
      persistLocalUserPreferences(next);
      schedulePreferencesSave(next);
      return next;
    });
  }, [queryClient]);

  return {
    preferences: query.data ?? DEFAULT_USER_PREFERENCES,
    setPreferences,
    ...query,
  };
}
