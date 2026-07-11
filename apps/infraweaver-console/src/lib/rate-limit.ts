// Sliding-window in-memory rate limiter.
// Resets on pod restart. For multi-replica deployments, back with Redis instead.
// NOTE: Uses x-real-ip (overwritten by Traefik) preferentially over the last
// x-forwarded-for hop; see rateLimitKey for the trust model and its limits.

interface RateLimitEntry {
  timestamps: number[];
  windowMs: number;
}

export const LOGIN_RATE_LIMIT = { max: 5, windowMs: 60_000 };
export const UNAUTHENTICATED_RATE_LIMIT = { max: 30, windowMs: 60_000 };

const store = new Map<string, RateLimitEntry>();

// Upper bound on distinct tracked keys. A caller that can vary its apparent
// client IP per request (spoofed x-real-ip / x-forwarded-for on a
// direct-to-pod path that never traversed Traefik) could otherwise grow the
// store without bound between the 60s cleanups — a memory-exhaustion DoS.
// When the cap is hit, UNSEEN keys are denied (fail closed) rather than
// allocated, so per-request IP churn cannot bypass the limiter either.
const MAX_TRACKED_KEYS = 10_000;

// Periodically clean up expired entries to prevent memory leaks.
// Uses the per-entry windowMs so expiry is always consistent with checkRateLimit.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    entry.timestamps = entry.timestamps.filter(t => now - t < entry.windowMs);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 60_000);

/**
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = store.get(key);
  if (!existing && store.size >= MAX_TRACKED_KEYS) {
    // Store at capacity and this key is unseen — deny instead of allocating,
    // so key-churn attacks fail closed instead of exhausting memory.
    return false;
  }
  const entry = existing ?? { timestamps: [], windowMs };
  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
  if (entry.timestamps.length >= max) {
    store.set(key, entry);
    return false;
  }
  entry.timestamps.push(now);
  store.set(key, entry);
  return true;
}

// Loose IPv4/IPv6 shape check (optionally with a port suffix appended by some
// proxies). Header values that do not even look like an IP are collapsed into
// the shared "invalid" bucket so spoofed junk cannot mint unlimited distinct
// rate-limit keys.
const IP_SHAPE_RE = /^[0-9a-fA-F.:]{2,45}$/;

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  const ip = value.trim();
  return IP_SHAPE_RE.test(ip) ? ip : null;
}

/**
 * Extracts the real client IP, preferring x-real-ip (overwritten by Traefik at
 * the trusted edge) over x-forwarded-for. NOTE: a caller that reaches the pod
 * directly (in-cluster service-to-service, kubectl port-forward) never
 * traversed Traefik and can set these headers itself — the runtime does not
 * expose the socket peer address here, so that cannot be verified in-process.
 * The defence for that path is fail-closed: non-IP-shaped values collapse into
 * one shared bucket, and per-request key churn is denied once
 * MAX_TRACKED_KEYS is reached (see checkRateLimit).
 */
export function rateLimitKey(prefix: string, req: Request): string {
  const headers = req.headers as Headers;
  const realIp = normalizeIp(headers.get("x-real-ip"));
  if (realIp) return `${prefix}:${realIp}`;
  // Fall back to x-forwarded-for only if x-real-ip is missing. Take the LAST
  // entry: each proxy APPENDS the peer it saw, so the last entry was added by
  // the nearest (trusted) proxy, while the FIRST entry is client-supplied and
  // trivially spoofable.
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const lastHop = normalizeIp(hops.length > 0 ? hops[hops.length - 1] : null);
    if (lastHop) return `${prefix}:${lastHop}`;
  }
  return `${prefix}:invalid`;
}
