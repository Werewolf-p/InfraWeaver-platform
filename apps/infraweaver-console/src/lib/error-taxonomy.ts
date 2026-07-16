/**
 * Client error taxonomy — PURE (no React; unit-testable). Maps any thrown
 * value from the data layer into a stable, user-friendly category so toasts,
 * banners, and error states speak one consistent language instead of leaking
 * raw "Request failed (503)" strings.
 */

export type ErrorKind =
  | "offline"
  | "unavailable"
  | "rateLimited"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "app"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  title: string;
  hint?: string;
  retryable: boolean;
  status?: number;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);

function statusOf(error: unknown): number | undefined {
  if (typeof Response !== "undefined" && error instanceof Response) return error.status;
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") break;
    const obj = current as Record<string, unknown>;
    if (typeof obj.status === "number") return obj.status;
    if (typeof obj.statusCode === "number") return obj.statusCode;
    current = obj.cause;
  }
  return undefined;
}

function networkCodeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") break;
    const obj = current as Record<string, unknown>;
    if (typeof obj.code === "string" && NETWORK_CODES.has(obj.code)) return obj.code;
    current = obj.cause;
  }
  return undefined;
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isAbort(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && /timeout|timed out|aborted/i.test(error.message))
  );
}

/** Classify an error into a stable category with a friendly title + retryability. */
export function classifyClientError(error: unknown): ClassifiedError {
  if (isOffline()) {
    return { kind: "offline", title: "You appear to be offline", hint: "Check your connection — data will refresh automatically.", retryable: true };
  }

  const status = statusOf(error);
  const networkCode = networkCodeOf(error);

  if (isAbort(error) || status === 408 || status === 504) {
    return { kind: "timeout", title: "The request timed out", hint: "The backend took too long — retrying may help.", retryable: true, status };
  }
  if (networkCode) {
    return { kind: "unavailable", title: "Can't reach the backend", hint: "A service is momentarily unreachable — backing off.", retryable: true };
  }

  if (status !== undefined) {
    if (status === 401) return { kind: "unauthorized", title: "Your session expired", hint: "Sign in again to continue.", retryable: false, status };
    if (status === 403) return { kind: "forbidden", title: "You don't have access to this", retryable: false, status };
    if (status === 404) return { kind: "notFound", title: "Not found", retryable: false, status };
    if (status === 429) return { kind: "rateLimited", title: "Too many requests", hint: "Slow down — retrying shortly.", retryable: true, status };
    if (RETRYABLE_STATUSES.has(status)) return { kind: "unavailable", title: "The service is temporarily unavailable", hint: "A backend is degraded — backing off and retrying.", retryable: true, status };
    if (status >= 400 && status < 500) return { kind: "app", title: messageOf(error) ?? "The request was rejected", retryable: false, status };
  }

  return { kind: "unknown", title: messageOf(error) ?? "Something went wrong", retryable: false, status };
}

function messageOf(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return undefined;
}
