// ─────────────────────────────────────────────────────────────────────────────
// service-fetch.ts — factory for a base-URL-bound fetch used by internal
// service clients. Applies the console-wide defaults every client repeats:
//   - cache: "no-store" (route handlers must never serve a cached upstream)
//   - a bounded AbortSignal.timeout (no hung upstreams)
// Per-call `init` wins over factory defaults (headers merge per key).
// ─────────────────────────────────────────────────────────────────────────────

/** Default per-request timeout for internal service calls (matches the Jellyfin/Authentik clients). */
export const SERVICE_FETCH_TIMEOUT_MS = 10_000;
/** Longer bound for slow upstream operations (matches iw-api's default). */
export const SERVICE_FETCH_LONG_TIMEOUT_MS = 30_000;

export interface ServiceFetchOptions {
  /** Base URL; trailing slashes are trimmed before `path` is appended. */
  baseUrl: string;
  /** Headers applied to every request (per-call init.headers override per key). */
  headers?: Record<string, string>;
  /** Convenience: sets `Authorization: Bearer <token>`. */
  token?: string;
  /** Per-request timeout; defaults to SERVICE_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type ServiceFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Build a fetch bound to a service base URL with no-store + timeout defaults.
 *
 * Usage:
 *   const nasFetch = createServiceFetch({ baseUrl, token, timeoutMs: 5_000 });
 *   const res = await nasFetch(`/api/v2.0/pool`);
 */
export function createServiceFetch(opts: ServiceFetchOptions): ServiceFetch {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? SERVICE_FETCH_TIMEOUT_MS;

  return (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(opts.headers);
    if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));

    return fetch(`${baseUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  };
}
