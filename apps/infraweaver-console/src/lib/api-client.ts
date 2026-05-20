import { safeError } from "@/lib/utils";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
  json?: unknown;
  query?: QueryParams;
  unwrap?: boolean;
}

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
  const { body, json, headers, query, unwrap = true, ...init } = options;

  const response = await fetch(buildUrl(path, query), {
    ...init,
    headers: json === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: json === undefined ? body : JSON.stringify(json),
  });

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
