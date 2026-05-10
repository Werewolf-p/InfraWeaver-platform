// Simple sliding-window in-memory rate limiter.
// Resets on pod restart. For multi-replica deployments, back with Redis instead.

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

/**
 * Returns true if the request is allowed, false if rate limited.
 * @param key      Unique bucket key (e.g. "prefix:ip")
 * @param max      Maximum requests allowed within the window
 * @param windowMs Sliding window duration in milliseconds
 */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
  if (entry.timestamps.length >= max) {
    store.set(key, entry);
    return false;
  }
  entry.timestamps.push(now);
  store.set(key, entry);
  return true;
}

/** Builds a rate-limit bucket key from a request's forwarded/remote IP. */
export function rateLimitKey(prefix: string, req: Request): string {
  const forwarded = (req.headers as Headers).get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";
  return `${prefix}:${ip}`;
}
