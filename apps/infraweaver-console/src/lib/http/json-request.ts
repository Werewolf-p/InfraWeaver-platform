// ─────────────────────────────────────────────────────────────────────────────
// json-request.ts — shared bounded JSON HTTP helper. Mirrors the private
// request<T> in lib/jellyfin/client.ts and lib/sso/authentik-client.ts so
// service clients can share one implementation:
//   - every request is bounded by AbortSignal.timeout (no hung upstreams)
//   - 204 / empty body → undefined
//   - only the STATUS of an error response is surfaced (bodies can echo input)
//   - timeout / unreachable / non-2xx map to a caller-supplied error via
//     onError so each client keeps its own error taxonomy (JellyfinError,
//     SsoUnavailableError, …).
// ─────────────────────────────────────────────────────────────────────────────

/** Default per-request timeout (matches the Jellyfin/Authentik clients). */
export const JSON_REQUEST_TIMEOUT_MS = 10_000;

export type JsonRequestFailureKind = "timeout" | "unreachable" | "status";

export interface JsonRequestFailure {
  kind: JsonRequestFailureKind;
  /** HTTP status — present only when kind === "status". */
  status?: number;
  method: string;
  url: string;
  timeoutMs: number;
  /** Underlying fetch error — present for "timeout" / "unreachable". */
  cause?: unknown;
}

export interface JsonRequestOptions {
  /** Defaults to GET. */
  method?: string;
  /** JSON-stringified when defined; omitted when undefined. */
  body?: unknown;
  /** Defaults to JSON_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Merged over the default JSON Content-Type/Accept headers. */
  headers?: Record<string, string>;
  /**
   * Map a failure to the error to throw (e.g. `new JellyfinError(...)`).
   * Defaults to a generic Error that never echoes response bodies.
   */
  onError?: (failure: JsonRequestFailure) => Error;
}

function defaultError(failure: JsonRequestFailure): Error {
  switch (failure.kind) {
    case "timeout":
      return new Error(`Request to ${failure.url} timed out after ${failure.timeoutMs}ms`);
    case "unreachable":
      return new Error(`${failure.url} is unreachable`);
    case "status":
      return new Error(`${failure.method} ${failure.url} failed: ${failure.status}`);
  }
}

/**
 * Bounded JSON request. Resolves to the parsed JSON body, or `undefined` for
 * 204 / empty responses. Throws the `onError`-mapped error on timeout,
 * network failure, or a non-2xx status (error bodies are never surfaced).
 */
export async function jsonRequest<T>(url: string, opts: JsonRequestOptions = {}): Promise<T | undefined> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? JSON_REQUEST_TIMEOUT_MS;
  const onError = opts.onError ?? defaultError;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw onError({ kind: isTimeout ? "timeout" : "unreachable", method, url, timeoutMs, cause: err });
  }

  // Only the status is surfaced — an upstream error body can echo back input.
  if (!res.ok) throw onError({ kind: "status", status: res.status, method, url, timeoutMs });
  if (res.status === 204) return undefined;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T | undefined;
}
