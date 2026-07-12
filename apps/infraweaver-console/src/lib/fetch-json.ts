/**
 * Typed JSON fetch for react-query queryFns — the shared copy of the inline
 * `fetch → if (!ok) throw → response.json()` pattern used across dashboard pages.
 */

export class FetchJsonError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "FetchJsonError";
    this.status = status;
    this.url = url;
  }
}

/**
 * Fetches `url` and returns the parsed JSON body typed as `T`.
 * Throws a {@link FetchJsonError} on any non-2xx response, preferring the
 * API's `{ error }` message when the body provides one.
 *
 * Defaults to `cache: "no-store"` (matching the existing queryFn copies);
 * pass `init.cache` to override.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) {
    let message = `Request failed (${response.status}) for ${url}`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
        message = (body as { error: string }).error;
      }
    } catch {
      // Non-JSON error body — keep the status-based message.
    }
    throw new FetchJsonError(message, response.status, url);
  }
  return response.json() as Promise<T>;
}
