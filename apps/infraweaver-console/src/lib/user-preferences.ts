export type ThemePreference = "light" | "dark" | "system";
export type DashboardDensity = "compact" | "comfortable";

export interface DashboardLayoutPreferences {
  widgets: Record<string, boolean>;
  navSections: Record<string, boolean>;
  density: DashboardDensity;
  startPage: string;
}

export interface RecentlyVisitedPage {
  href: string;
  title: string;
  visitedAt: number;
}

export interface RecentSearchEntry {
  query: string;
  usedAt: number;
}

export interface UserPreferencesPayload {
  dashboardLayout: DashboardLayoutPreferences;
  pinnedApps: string[];
  theme: ThemePreference;
  recentlyVisited: RecentlyVisitedPage[];
  recentSearches: RecentSearchEntry[];
}

export interface UserPreferencesUpdate {
  dashboardLayout?: Partial<DashboardLayoutPreferences> & {
    widgets?: Record<string, boolean>;
    navSections?: Record<string, boolean>;
  };
  pinnedApps?: string[];
  theme?: ThemePreference;
  recentlyVisited?: RecentlyVisitedPage[];
  recentSearches?: RecentSearchEntry[];
}

export const USER_PREFERENCES_QUERY_KEY = ["user", "preferences"] as const;

export const USER_PREFERENCES_STORAGE_KEYS = {
  dashboardLayout: "infraweaver_prefs",
  pinnedApps: "infraweaver:favorites",
  recentlyVisited: "infraweaver:recent-pages",
  recentSearches: "infraweaver:recent-searches",
  theme: "theme",
  legacyTheme: "iw-theme",
} as const;

export const MAX_RECENTLY_VISITED = 10;
export const MAX_RECENT_SEARCHES = 8;

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutPreferences = {
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

export const DEFAULT_USER_PREFERENCES: UserPreferencesPayload = {
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
  pinnedApps: [],
  theme: "system",
  recentlyVisited: [],
  recentSearches: [],
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function normalizePinnedApps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))];
}

export function normalizeRecentlyVisited(value: unknown): RecentlyVisitedPage[] {
  if (!Array.isArray(value)) return [];

  const pages = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const page = entry as Partial<RecentlyVisitedPage>;
      if (typeof page.href !== "string" || page.href.trim().length === 0) return null;
      const visitedAt = Number.isFinite(page.visitedAt) ? Math.max(0, Math.trunc(page.visitedAt ?? 0)) : Date.now();
      return {
        href: page.href,
        title: typeof page.title === "string" && page.title.trim().length > 0 ? page.title : page.href,
        visitedAt,
      } satisfies RecentlyVisitedPage;
    })
    .filter((page): page is RecentlyVisitedPage => Boolean(page));

  const seen = new Set<string>();
  return pages
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .filter((page) => {
      if (seen.has(page.href)) return false;
      seen.add(page.href);
      return true;
    })
    .slice(0, MAX_RECENTLY_VISITED);
}

export function normalizeRecentSearches(value: unknown): RecentSearchEntry[] {
  if (!Array.isArray(value)) return [];

  const entries = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Partial<RecentSearchEntry>;
      if (typeof candidate.query !== "string" || candidate.query.trim().length === 0) return null;
      const usedAt = Number.isFinite(candidate.usedAt) ? Math.max(0, Math.trunc(candidate.usedAt ?? 0)) : Date.now();
      return {
        query: candidate.query.trim(),
        usedAt,
      } satisfies RecentSearchEntry;
    })
    .filter((entry): entry is RecentSearchEntry => Boolean(entry));

  const seen = new Set<string>();
  return entries
    .sort((a, b) => b.usedAt - a.usedAt)
    .filter((entry) => {
      const key = entry.query.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RECENT_SEARCHES);
}

export function mergeDashboardLayout(
  base: DashboardLayoutPreferences,
  update?: Partial<DashboardLayoutPreferences> & {
    widgets?: Record<string, boolean>;
    navSections?: Record<string, boolean>;
  }
): DashboardLayoutPreferences {
  if (!update) return base;

  return {
    widgets: update.widgets ? { ...base.widgets, ...update.widgets } : base.widgets,
    navSections: update.navSections ? { ...base.navSections, ...update.navSections } : base.navSections,
    density: update.density ?? base.density,
    startPage: update.startPage ?? base.startPage,
  };
}

export function mergeUserPreferences(
  base: UserPreferencesPayload,
  update: UserPreferencesUpdate = {}
): UserPreferencesPayload {
  return {
    dashboardLayout: update.dashboardLayout
      ? mergeDashboardLayout(base.dashboardLayout, update.dashboardLayout)
      : base.dashboardLayout,
    pinnedApps: update.pinnedApps ? normalizePinnedApps(update.pinnedApps) : base.pinnedApps,
    theme: update.theme ?? base.theme,
    recentlyVisited: update.recentlyVisited
      ? normalizeRecentlyVisited(update.recentlyVisited)
      : base.recentlyVisited,
    recentSearches: update.recentSearches
      ? normalizeRecentSearches(update.recentSearches)
      : base.recentSearches,
  };
}

export function normalizeUserPreferences(value: unknown): UserPreferencesPayload {
  if (!value || typeof value !== "object") return DEFAULT_USER_PREFERENCES;

  const candidate = value as Partial<UserPreferencesPayload>;
  return mergeUserPreferences(DEFAULT_USER_PREFERENCES, {
    dashboardLayout: candidate.dashboardLayout && typeof candidate.dashboardLayout === "object"
      ? candidate.dashboardLayout as UserPreferencesUpdate["dashboardLayout"]
      : undefined,
    pinnedApps: normalizePinnedApps(candidate.pinnedApps),
    theme: isThemePreference(candidate.theme) ? candidate.theme : undefined,
    recentlyVisited: normalizeRecentlyVisited(candidate.recentlyVisited),
    recentSearches: normalizeRecentSearches(candidate.recentSearches),
  });
}
