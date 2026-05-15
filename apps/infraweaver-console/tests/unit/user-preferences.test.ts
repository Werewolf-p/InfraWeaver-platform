import {
  DEFAULT_USER_PREFERENCES,
  mergeUserPreferences,
  normalizeRecentSearches,
  normalizeUserPreferences,
} from "@/lib/user-preferences";

describe("user preferences", () => {
  it("normalizes recent searches by recency and uniqueness", () => {
    const searches = normalizeRecentSearches([
      { query: "pods", usedAt: 100 },
      { query: "Pods", usedAt: 200 },
      { query: "logs", usedAt: 150 },
      { query: "", usedAt: 250 },
    ]);

    expect(searches).toEqual([
      { query: "Pods", usedAt: 200 },
      { query: "logs", usedAt: 150 },
    ]);
  });

  it("merges recent searches without losing other defaults", () => {
    const merged = mergeUserPreferences(DEFAULT_USER_PREFERENCES, {
      recentSearches: [
        { query: "pods", usedAt: 10 },
        { query: "apps", usedAt: 20 },
      ],
    });

    expect(merged.recentSearches).toHaveLength(2);
    expect(merged.dashboardLayout.startPage).toBe("/home");
    expect(merged.pinnedApps).toEqual([]);
  });

  it("normalizes legacy payloads without recent searches", () => {
    const preferences = normalizeUserPreferences({
      pinnedApps: ["/apps"],
      recentlyVisited: [{ href: "/apps", title: "Apps", visitedAt: 20 }],
    });

    expect(preferences.recentSearches).toEqual([]);
    expect(preferences.pinnedApps).toEqual(["/apps"]);
  });
});
