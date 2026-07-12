import "server-only";
import { signHmac } from "@/lib/hmac";

/**
 * Generic client for the InfraWeaver dispatch service — SERVER ONLY.
 *
 * Extracts the transport shared by feedback-dispatch.ts and
 * feedback-automation.ts so new dispatch endpoints don't re-implement it.
 * The SECURITY POSTURE of those modules is preserved exactly:
 *
 *  - FAIL-SAFE on missing DISPATCH_URL: reads return `null`, mutations return
 *    `{ ok: false, skipped: true }` — a console flow is never blocked by
 *    integration wiring.
 *  - FAIL-CLOSED on missing DISPATCH_SECRET: mutations are REFUSED (reported
 *    as `skipped`) rather than sent unsigned — an unsigned mutation channel
 *    would let any in-cluster caller drive publish/deploy once dispatch
 *    trusts it. Reads are unsigned by design (dispatch verifies mutations).
 *
 * Mutations are signed under the canonical HMAC scheme (see `@/lib/hmac`):
 * the body is serialized ONCE and that exact string is both sent and signed,
 * so the dispatch verifier's HMAC over the raw received bytes matches.
 */

const DISPATCH_URL = process.env.DISPATCH_URL;
const DISPATCH_SECRET = process.env.DISPATCH_SECRET;

const MISSING = "dispatch service not configured (DISPATCH_URL)";
const MISSING_SECRET = "dispatch HMAC secret not configured (DISPATCH_SECRET); refusing to send unsigned mutation";

/** Quick calls (config reads, verdict posts). */
export const DISPATCH_QUICK_TIMEOUT_MS = 10_000;
/** Long calls (agent run + in-cluster build can take ~20 min). */
export const DISPATCH_LONG_TIMEOUT_MS = 25 * 60_000;

export interface DispatchRequestOptions {
  /** Default {@link DISPATCH_QUICK_TIMEOUT_MS}; pass {@link DISPATCH_LONG_TIMEOUT_MS} for agent/build runs. */
  timeoutMs?: number;
}

export interface DispatchMutateOptions extends DispatchRequestOptions {
  /** HTTP method for the mutation. Default "POST". Always HMAC-signed. */
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
}

/** Result of a mutating dispatch call (mirrors DispatchResult / AutomationResult). */
export interface DispatchMutationResult<T> {
  ok: boolean;
  /** True when the call was not attempted (DISPATCH_URL or DISPATCH_SECRET unset). */
  skipped?: boolean;
  error?: string;
  data?: T;
}

/** True when the dispatch service is configured (mutations additionally require DISPATCH_SECRET). */
export function isDispatchConfigured(): boolean {
  return Boolean(DISPATCH_URL);
}

/**
 * Fail-safe GET. Returns the JSON payload as T, or `null` when the dispatch
 * service is unconfigured, unreachable, times out, or responds non-2xx —
 * mirroring the read helpers in feedback-dispatch/feedback-automation, so
 * views degrade to an empty state instead of throwing.
 */
export async function dispatchGet<T>(pathname: string, opts: DispatchRequestOptions = {}): Promise<T | null> {
  if (!DISPATCH_URL) return null;
  const timeoutMs = opts.timeoutMs ?? DISPATCH_QUICK_TIMEOUT_MS;
  try {
    const res = await fetch(new URL(pathname, DISPATCH_URL), {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * HMAC-signed mutation. Fail-safe on missing DISPATCH_URL and fail-CLOSED on
 * missing DISPATCH_SECRET (both reported as `skipped`, never thrown). The body
 * is serialized once and signed as `${timestamp}.${rawBody}` with lowercase
 * hex HMAC-SHA256 in `X-IW-Signature` / `X-IW-Timestamp`.
 *
 * A payload of `{ ok: false, ... }` from dispatch is surfaced as a failure
 * (dispatch endpoints use the `ok` envelope), otherwise the payload is
 * returned as `data`.
 */
export async function dispatchMutate<T>(
  pathname: string,
  body: Record<string, unknown>,
  opts: DispatchMutateOptions = {},
): Promise<DispatchMutationResult<T>> {
  if (!DISPATCH_URL) return { ok: false, skipped: true, error: MISSING };
  // Fail CLOSED: never send a mutation unsigned — refuse (as `skipped`) until
  // ops provisions the shared secret on both sides.
  if (!DISPATCH_SECRET) {
    console.warn(`[dispatch-client] ${MISSING_SECRET} (${opts.method ?? "POST"} ${pathname} not sent)`);
    return { ok: false, skipped: true, error: MISSING_SECRET };
  }

  const timeoutMs = opts.timeoutMs ?? DISPATCH_QUICK_TIMEOUT_MS;
  try {
    // Serialize the body ONCE — the exact string is both sent and signed so the
    // dispatch verifier's HMAC over the raw received bytes matches.
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const res = await fetch(new URL(pathname, DISPATCH_URL), {
      method: opts.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        "X-IW-Timestamp": timestamp,
        "X-IW-Signature": signHmac(`${timestamp}.${rawBody}`, DISPATCH_SECRET),
      },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await res.json().catch(() => null)) as (Partial<{ ok: boolean; error: string }> & T) | null;
    if (!res.ok) return { ok: false, error: payload?.error ?? `dispatch responded ${res.status}` };
    if (payload && payload.ok === false) return { ok: false, error: payload.error ?? "dispatch reported failure", data: payload as T };
    return { ok: true, data: (payload ?? undefined) as T | undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "dispatch call failed" };
  }
}
