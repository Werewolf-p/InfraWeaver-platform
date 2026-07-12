/**
 * @/lib/retry — Shared retry-with-backoff helper.
 *
 * Mirrors the fixed-delay retry loops in rbac-assignments.ts and
 * jellyfin/access.ts ([1s, 5s, 15s], attempts = delays.length + 1) so call
 * sites can share one implementation. Unlike those void fire-and-forget loops,
 * this returns the operation's value and RETHROWS the final error after
 * logging it — callers that want best-effort semantics catch it themselves.
 *
 * Kept dependency-free (like retryable-error.ts) so it can be unit tested in
 * isolation and reused by route handlers and library code alike.
 */

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

/**
 * Runs `fn`, retrying after each delay in `delaysMs` (so `delaysMs.length + 1`
 * attempts total). `label` prefixes the log lines; `giveUpHint` is appended to
 * the final error log to tell an operator how to recover manually.
 */
export async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  giveUpHint?: string,
): Promise<T> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === delaysMs.length) {
        console.error(
          `[retry] ${label} failed after ${attempt + 1} attempt${attempt === 0 ? "" : "s"}${giveUpHint ? `; ${giveUpHint}` : ""}:`,
          message,
        );
        throw err;
      }
      console.warn(`[retry] ${label} attempt ${attempt + 1} failed, retrying in ${delaysMs[attempt]}ms:`, message);
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
  // Unreachable: the loop always returns or rethrows on the final attempt.
  throw new Error(`retryWithBackoff(${label}): exhausted retries`);
}
