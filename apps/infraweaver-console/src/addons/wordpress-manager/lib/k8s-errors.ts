/**
 * Self-contained helpers for interpreting @kubernetes/client-node errors. In
 * v1.x the thrown error is an `ApiException` carrying a numeric `.code` (the HTTP
 * status); we also tolerate the older `.statusCode` / `.body.code` shapes so the
 * addon stays robust across client versions. Kept addon-local so the addon does
 * not reach into another addon's helpers.
 */
export function k8sErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; statusCode?: unknown; body?: { code?: unknown } };
  if (typeof e.code === "number") return e.code;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.body?.code === "number") return e.body.code;
  return null;
}

export function isK8sNotFound(error: unknown): boolean {
  return k8sErrorStatus(error) === 404;
}

/** node-fetch/undici error codes for a dropped or refused kube-apiserver connection. */
const TRANSIENT_API_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True for a transient kube-apiserver connection failure — surfaced by the k8s
 * client as a node-fetch/undici NETWORK error with no HTTP status, e.g. "socket
 * hang up" or "Client network socket disconnected before secure TLS connection
 * was established". Under the concurrent fleet sweep these spike as the ~5
 * simultaneous Secret/ConfigMap reads+writes contend for connections. Re-reading
 * is safe on an idempotent read. Distinct from a 409 Conflict, which carries an
 * HTTP status. Walks the `cause` chain so a wrapped fetch failure still matches.
 */
export function isTransientApiError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth += 1) {
    if (typeof cur === "object") {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && TRANSIENT_API_ERROR_CODES.has(code)) return true;
    }
    const message = cur instanceof Error ? cur.message : String(cur);
    if (
      /socket hang up|socket disconnected|network socket disconnected|secure TLS connection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(
        message,
      )
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full-jitter exponential backoff for a bounded retry. `retry` is 0-based (the
 * wait BEFORE the n-th retry). Jitter avoids the concurrent fleet sweep
 * re-colliding its retries into the same window (thundering herd on the apiserver).
 */
function backoffDelayMs(retry: number, baseMs: number): number {
  return Math.floor(Math.random() * baseMs * 2 ** retry);
}

/**
 * Run an idempotent kube-apiserver read with a bounded, jittered retry on a
 * transient connection drop (see isTransientApiError). Mirrors the retry that
 * mutateExternalSites applies to its read-modify-write, but for a pure read: no
 * optimistic-concurrency handling, just re-issue the call. Non-transient errors
 * (404, 403, 409, anything with an HTTP status) propagate on the first attempt.
 */
export async function retryOnTransientApiError<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 25;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1, baseMs));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientApiError(err) || attempt === attempts - 1) throw err;
    }
  }
  throw lastErr;
}
