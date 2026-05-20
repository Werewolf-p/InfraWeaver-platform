// Sliding-window in-memory rate limiter.
// Resets on pod restart. For multi-replica deployments, back with Redis instead.
// NOTE: Uses x-real-ip (set by Traefik) preferentially over x-forwarded-for.
// x-forwarded-for can be spoofed by clients; x-real-ip is set by the trusted proxy.

interface RateLimitEntry {
  timestamps: number[];
}

export const LOGIN_RATE_LIMIT = { max: 5, windowMs: 60_000 };
export const UNAUTHENTICATED_RATE_LIMIT = { max: 30, windowMs: 60_000 };

const store = new Map<string, RateLimitEntry>();

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    entry.timestamps = entry.timestamps.filter(t => now - t < 3_600_000);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 60_000);

/**
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
  if (entry.timestamps.length >= max) {
    store.set(key, entry);
    return false;
  }
  entry.timestamps.push(now);
  store.set(key, entry);
  return true;
}

/**
 * Extracts the real client IP, preferring x-real-ip (set by trusted proxy)
 * over x-forwarded-for (can be spoofed by clients).
 */
export function rateLimitKey(prefix: string, req: Request): string {
  const headers = req.headers as Headers;
  // x-real-ip is set by Traefik and cannot be spoofed by end clients
  const realIp = headers.get("x-real-ip");
  if (realIp) return `${prefix}:${realIp.trim()}`;
  // Fall back to first entry of x-forwarded-for only if x-real-ip is missing
  const forwarded = headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";
  return `${prefix}:${ip}`;
}
