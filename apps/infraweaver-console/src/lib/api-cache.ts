import { NextResponse } from "next/server";

interface CacheEntry<T> {
  data: T;
  expires: number;
}

function escapeRegExp(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\*/g, ".*").replace(/\\\?/g, ".")}$`);
}

class ApiCache {
  private cache = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, { data, expires: Date.now() + ttlMs });
  }

  invalidate(pattern: string): void {
    const matcher = globToRegExp(pattern);
    for (const key of this.cache.keys()) {
      if (matcher.test(key)) {
        this.cache.delete(key);
      }
    }
  }
}

export const apiCache = new ApiCache();

export function withCacheControl<T>(
  data: T,
  options: { sMaxAge?: number; staleWhileRevalidate?: number } = {},
): NextResponse<T> {
  const { sMaxAge = 30, staleWhileRevalidate = 60 } = options;
  const response = NextResponse.json(data);
  response.headers.set(
    "Cache-Control",
    `public, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  );
  return response;
}
