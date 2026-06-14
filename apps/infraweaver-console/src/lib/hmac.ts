import "server-only";
import { createHmac } from "node:crypto";

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
