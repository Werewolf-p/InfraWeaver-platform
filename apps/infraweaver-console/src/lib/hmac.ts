import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical HMAC scheme shared with the dispatch service (server.js).
 *
 *   secret        = env DISPATCH_SECRET
 *   signing input = `${timestamp}.${rawBody}` where rawBody is the EXACT JSON
 *                   string sent as the request body (JSON.stringify(body) here;
 *                   the raw received bytes on the dispatch verifier side)
 *   signature     = lowercase hex HMAC-SHA256
 *   headers       = X-IW-Timestamp (Date.now() ms as a string), X-IW-Signature
 *
 * This is a server-only module, so node:crypto is safe (NOT middleware).
 */
export function signHmac(message: string, secret: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** Default replay window for HMAC-authenticated requests (±5 minutes of clock skew). */
export const HMAC_SKEW_MS = 5 * 60_000;

export interface VerifyHmacInput {
  /** `X-IW-Timestamp` header (epoch ms as a string), or null if absent. */
  timestamp: string | null;
  /** `X-IW-Signature` header (lowercase hex HMAC-SHA256), or null if absent. */
  signature: string | null;
  /** The EXACT raw request body bytes the signature was computed over. */
  rawBody: string;
  /** Shared secret. An empty secret always fails (fail-closed). */
  secret: string;
  /** Current time in epoch ms (injectable for tests). */
  now: number;
  /** Allowed clock skew / replay window in ms (default `HMAC_SKEW_MS`). */
  skewMs?: number;
}

/**
 * Verify an HMAC-signed request under the canonical scheme (see `signHmac`):
 * signature = HMAC-SHA256(`${timestamp}.${rawBody}`, secret). Fails closed on a
 * missing secret/header, a non-numeric or out-of-window timestamp (replay
 * guard), or a mismatched signature. Comparison is constant-time. Never throws
 * on malformed input.
 */
export function verifyHmac(input: VerifyHmacInput): boolean {
  const { timestamp, signature, rawBody, secret, now } = input;
  const skewMs = input.skewMs ?? HMAC_SKEW_MS;
  if (!secret || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > skewMs) return false;

  const expected = signHmac(`${timestamp}.${rawBody}`, secret);
  let actualBuffer: Buffer;
  let expectedBuffer: Buffer;
  try {
    actualBuffer = Buffer.from(signature, "hex");
    expectedBuffer = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (actualBuffer.length === 0 || actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
