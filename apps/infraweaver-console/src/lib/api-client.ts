import { safeError } from "@/lib/utils";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
  json?: unknown;
  query?: QueryParams;
  unwrap?: boolean;
  /** Max attempts on transient failures (network error / 502 / 503 / 504). Default 3. Set 1 to disable. */
  retries?: number;
  /** Abort the request after this many ms. Default 20000. */
  timeoutMs?: number;
}

// Browsers surface a transient network drop (single-replica pod restarting,
// proxy hiccup, brief unavailability) as a bare TypeError — "Failed to fetch"
// (Chrome) / "Load failed" (Safari). Those were the exact symptoms reported when
// sending feedback and when clicking publish. A short bounded retry on these
// transient conditions makes those one-off blips invisible to the user.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

function isTransientNetworkError(error: unknown): boolean {
  // fetch() rejects with a TypeError on network-level failure; AbortError means
  // our own timeout fired (also worth one more try). Real app errors are thrown
  // as plain Error from apiRequest and must NOT be retried.
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Normalizes relative API paths and appends optional query parameters.
 */
function buildUrl(path: string, query?: QueryParams) {
  const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, baseUrl);

  if (query) {
    for (const [key, rawValue] of Object.entries(query)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value === null || value === undefined || value === "") {
          continue;
        }
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.origin === new URL(baseUrl).origin ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }

  return fallback;
}

function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return payload.data as T;
  }

  return payload as T;
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Executes a JSON API request and transparently unwraps `{ data, meta }` envelopes.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const {
    body,
    json,
    headers,
    query,
    unwrap = true,
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: callerSignal,
    ...init
  } = options;

  const url = buildUrl(path, query);
  const maxAttempts = Math.max(1, retries);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Per-attempt timeout so a hung connection can't wedge the UI; honour any
    // caller-provided AbortSignal too.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: json === undefined ? headers : { "Content-Type": "application/json", ...headers },
        body: json === undefined ? body : JSON.stringify(json),
      });

      // Retry transient gateway errors (pod/proxy momentarily unavailable).
      if (TRANSIENT_STATUSES.has(response.status) && attempt < maxAttempts) {
        await sleep(250 * attempt);
        continue;
      }

      return await finalizeResponse<T>(response, unwrap);
    } catch (error) {
      lastError = error;
      // A caller-initiated abort is intentional — never retry or swallow it.
      if (callerSignal?.aborted) throw error;
      if (isTransientNetworkError(error) && attempt < maxAttempts) {
        await sleep(250 * attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

async function finalizeResponse<T>(response: Response, unwrap: boolean): Promise<T> {
  const payload = await parseJsonResponse(response);

  if (response.status === 401) {
    // Session expired — redirect to the login URL the API provided, or /login
    if (typeof window !== "undefined") {
      const loginUrl = (payload as { loginUrl?: string } | null)?.loginUrl ?? "/login";
      window.location.href = loginUrl;
    }
    throw new Error("Session expired");
  }

  if (response.status === 403) {
    throw new Error("You don't have permission to perform this action");
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, response.statusText || "Request failed"));
  }

  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    throw new Error(payload.error);
  }

  return unwrap ? unwrapPayload<T>(payload) : (payload as T);
}

export const apiClient = {
  request: apiRequest,
  get<T>(path: string, options?: Omit<ApiRequestOptions, "method">) {
    return apiRequest<T>(path, { ...options, method: "GET" });
  },
  post<T>(path: string, options?: Omit<ApiRequestOptions, "method">) {
    return apiRequest<T>(path, { ...options, method: "POST" });
  },
  put<T>(path: string, options?: Omit<ApiRequestOptions, "method">) {
    return apiRequest<T>(path, { ...options, method: "PUT" });
  },
  patch<T>(path: string, options?: Omit<ApiRequestOptions, "method">) {
    return apiRequest<T>(path, { ...options, method: "PATCH" });
  },
  delete<T>(path: string, options?: Omit<ApiRequestOptions, "method">) {
    return apiRequest<T>(path, { ...options, method: "DELETE" });
  },
};

/**
 * Converts unknown errors into a user-safe message for toasts and inline errors.
 */
export function toApiErrorMessage(error: unknown, fallback = "Request failed") {
  const message = safeError(error);
  return message === "An error occurred" ? fallback : message;
}
