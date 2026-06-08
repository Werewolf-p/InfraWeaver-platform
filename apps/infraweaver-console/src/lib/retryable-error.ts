/**
 * Classifies errors as transient infrastructure blips vs. genuine application
 * errors. Kept dependency-free (no next/server, no auth) so it can be unit
 * tested in isolation and reused by route handlers and library code alike.
 */

// Transient infrastructure failures worth a client retry: the Kubernetes API /
// in-cluster proxy momentarily unreachable (the single-replica console pod
// restarting or an exit-139 crash), a reset/refused socket, a DNS blip, or a
// gateway 5xx. These are distinct from genuine application errors (validation,
// conflict, not-found) which must not be retried.
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/**
 * True when `error` looks like a transient infrastructure blip rather than a
 * real application error. Walks the `cause` chain (Node's `fetch` wraps the
 * socket error as `TypeError("fetch failed")` with a `cause`) and inspects
 * status/error codes and message text.
 *
 * Surfacing these as HTTP 503 lets the resilient API client retry them
 * transparently — the fix for the intermittent "failed to publish / failed to
 * fetch" reports, where a brief Kubernetes read failure in the publish path was
 * returned as a non-retryable 500.
 */
export function isRetryableInfraError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;

  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") break;
    const obj = current as Record<string, unknown>;
    if (typeof obj.code === "string" && RETRYABLE_NETWORK_CODES.has(obj.code)) return true;
    const status =
      typeof obj.statusCode === "number"
        ? obj.statusCode
        : typeof obj.code === "number"
          ? obj.code
          : undefined;
    if (status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) return true;
    current = obj.cause;
  }

  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("socket disconnected") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable")
  );
}
