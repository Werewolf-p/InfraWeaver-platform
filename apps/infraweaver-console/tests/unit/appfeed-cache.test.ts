import { findAppByIdentifier, findAppByName, invalidateAppFeedCache, type AppFeedResponse } from "@/lib/appfeed-cache";

describe("appfeed-cache lookups", () => {
  const originalFetch = global.fetch;

  const sampleFeed: AppFeedResponse = {
    apps: 3,
    last_updated: "2026-05-18",
    last_updated_timestamp: 1747526400,
    categories: [],
    applist: [
      { Name: "Postgres12.5", Repository: "postgres:12.5" },
      { Name: "Postgres12.5", Repository: "ghcr.io/example/postgres:12.5" },
      { Name: "IT-Tools", Repository: "ghcr.io/corentinth/it-tools:latest" },
    ],
  };

  beforeEach(() => {
    invalidateAppFeedCache();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleFeed,
    } as Response);
  });

  afterEach(() => {
    invalidateAppFeedCache();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("finds apps by exact name", async () => {
    await expect(findAppByName("it-tools")).resolves.toMatchObject({
      Name: "IT-Tools",
      Repository: "ghcr.io/corentinth/it-tools:latest",
    });
  });

  it("finds apps by slug when the feed name differs", async () => {
    await expect(findAppByIdentifier("postgres12-5")).resolves.toMatchObject({
      Name: "Postgres12.5",
      Repository: "ghcr.io/example/postgres:12.5",
    });
  });

  it("returns null for unknown identifiers", async () => {
    await expect(findAppByIdentifier("missing-app")).resolves.toBeNull();
  });
});
