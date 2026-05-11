/**
 * appfeed-cache.ts
 *
 * In-memory cache for the Unraid Community Applications AppFeed.
 *
 * Why not Next.js fetch cache?
 *   Next.js has a hard 2MB limit on its data cache. The AppFeed is ~33MB,
 *   so `next: { revalidate: 7200 }` silently fails — every request would
 *   re-download 33MB from GitHub raw.
 *
 * This module-level cache stores the parsed feed object in Node.js memory.
 * It persists across requests in the same process (per pod). Each pod caches
 * independently but that's fine — worst case, 2 pods each download it once.
 *
 * Properties:
 *   - TTL: 2 hours (matches AppFeed update cadence)
 *   - Deduplication: concurrent requests share a single inflight promise
 *   - No size limit (it's just a JS object reference)
 *   - Warm-up: first request after pod start triggers a download (~2–5s)
 */

import type { AppFeedEntry } from "./appfeed-converter";

export interface AppFeedResponse {
  apps: number;
  last_updated: string;
  last_updated_timestamp: number;
  categories: Array<{ Cat: string; Des: string }>;
  applist: AppFeedEntry[];
}

const APPFEED_URL =
  "https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json";
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface CacheEntry {
  data: AppFeedResponse;
  fetchedAt: number;
}

// Module-level state — persists across requests in the same Node.js process
let cache: CacheEntry | null = null;
let inflight: Promise<AppFeedResponse> | null = null;

/**
 * Returns the AppFeed, fetching from GitHub if the cache is stale or missing.
 * Concurrent callers all await the same promise — no duplicate downloads.
 */
export async function getAppFeed(): Promise<AppFeedResponse> {
  const now = Date.now();

  // Return cached data if still fresh
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.data;
  }

  // Deduplicate: if a fetch is already in-flight, wait for it
  if (inflight) return inflight;

  inflight = fetch(APPFEED_URL, {
    headers: { "User-Agent": "InfraWeaver-Console/1.0 (homelab platform)" },
    // Use fetch without Next.js caching since the feed is too large for it
    cache: "no-store",
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`AppFeed fetch failed: ${res.status}`);
      const data = (await res.json()) as AppFeedResponse;
      cache = { data, fetchedAt: Date.now() };
      inflight = null;
      return data;
    })
    .catch((err: unknown) => {
      inflight = null;
      throw err;
    });

  return inflight;
}

/**
 * Look up a single app by exact name (case-insensitive).
 * Uses the same cache as getAppFeed().
 */
export async function findAppByName(name: string): Promise<AppFeedEntry | null> {
  const feed = await getAppFeed();
  const lower = name.toLowerCase();
  return (
    feed.applist.find(
      (a) => typeof a.Name === "string" && a.Name.toLowerCase() === lower
    ) ?? null
  );
}

/** Invalidate the cache (useful for testing or manual refresh). */
export function invalidateAppFeedCache(): void {
  cache = null;
}
