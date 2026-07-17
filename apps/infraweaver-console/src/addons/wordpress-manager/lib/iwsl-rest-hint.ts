/**
 * Plain-permalink detection for the IWSL REST surface (§5).
 *
 * A WordPress site on *plain* permalinks (`?p=123`) has no rewrite rule for
 * `/wp-json/...`, so every Connector endpoint — the passive `/enroll-proof`
 * document and the signed `/command` channel — resolves to the site's HTML
 * homepage (or a 3xx to it) instead of the JSON the plugin emits. At the byte
 * level this is indistinguishable from "plugin missing", so both the enroll
 * verify-pull and the external health check would otherwise report a bare
 * "unreadable response" / 502. Sniffing the response lets us point the operator
 * at the actual one-line fix instead.
 */

/**
 * Leading markup — an HTML doc, an XML doc, a comment, or any opening/closing
 * tag. Only consulted once JSON parsing has already failed, so a `<` prefix is
 * a reliable "this is a rendered page, not a REST reply" signal.
 */
const MARKUP_PREFIX_RE = /^\s*<(?:!doctype|!--|\?xml|\/?[a-z])/i;

/** True when a REST response body is markup (WordPress HTML), not the expected JSON. */
export function looksLikeWordpressHtml(body: string): boolean {
  return MARKUP_PREFIX_RE.test(body);
}

/**
 * True when a non-JSON REST response looks like the plain-permalinks symptom:
 * either WordPress served its HTML page, or it 3xx-redirected `/wp-json/...`
 * toward the homepage. Callers use it to swap the generic error for the hint.
 */
export function isPlainPermalinkSymptom(status: number, body: string): boolean {
  const redirected = status >= 300 && status < 400;
  return redirected || looksLikeWordpressHtml(body);
}

/**
 * Operator-facing message for the plain-permalinks symptom. Leads with the
 * observable fact, then the exact remedy.
 */
export const PLAIN_PERMALINKS_HINT =
  "REST returned non-JSON — the target is on plain permalinks, so /wp-json never reaches the Connector. " +
  "Enable pretty permalinks (Settings → Permalinks → Post name, or `wp rewrite structure '/%postname%/' --hard`) and retry.";
