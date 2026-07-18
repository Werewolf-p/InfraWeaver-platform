/**
 * IWSL clone / identity-crisis detection + safe-mode decision (§5, §12.5).
 *
 * A link's identity is `site_id` + the site's own canonical URL. The `site_id`
 * and the pinned keys travel with a database, so a CLONE (the WP DB — including
 * the `iwsl_` key material — copied to another domain) or an in-place migration
 * holds VALID keys and answers signed commands correctly. Each health.check /
 * debug.status carries the plugin's live `home_url()` inside the Ed25519-signed
 * response, so the console reads it only AFTER verifying the signature — a
 * network MITM can neither forge nor strip it.
 *
 * SCOPE — this is a BEST-EFFORT detector, not a hard security boundary. The
 * self-reported URL is attested by the answering server itself, and a KNOWING
 * clone operator who holds the exfiltrated signing key also controls what
 * `home_url()` returns (e.g. `define('WP_HOME', …)` matching the original), so a
 * deliberate adversary can evade the URL comparison. What it reliably catches is
 * the common, careless case: an unintentional clone/staging copy or a real
 * domain migration that still reports its NEW url. The hard boundaries remain
 * the per-site key fingerprint (pinned WP-PK), the enrollment possession proof,
 * and — for external links — TLS SPKI pinning. One evasion IS closed here: a
 * link that has reported a URL before and then STOPS (a cheap way to slip into
 * "no signal" by breaking `home`) is treated as a regression and trips safe mode
 * rather than being silently exempted — see `evaluateIdentity`.
 *
 * This module is the pure decision layer, deliberately isomorphic (no
 * `server-only`, no k8s) so it is unit-testable in isolation. All URL
 * normalization lives HERE so a bound URL and a freshly observed one are always
 * compared through the same canonicalizer.
 */

/** Why the link entered safe mode — surfaced to the operator + audit. */
export type IdentityAlertReason = "url-changed" | "stopped-reporting";

/** The mismatch that tripped safe mode. */
export interface IdentityAlert {
  reason: IdentityAlertReason;
  /**
   * Canonical URL the link now self-reports (normalized). Empty string for
   * `stopped-reporting` (the link no longer reports a URL at all).
   */
  observedUrl: string;
  /** Canonical URL the link was bound/confirmed to (normalized). */
  boundUrl: string;
  /** ISO timestamp the mismatch was observed — also the confirm anti-TOCTOU token. */
  at: string;
}

/** The identity slice of a link record this module reads and rewrites. */
export interface IdentityState {
  /** Confirmed canonical URL (normalized). Absent until the first self-report. */
  canonicalUrl?: string;
  /** Safe mode: state-changing ops are suspended until an operator re-confirms. */
  identitySuspended?: boolean;
  /** Details of the mismatch that suspended the link. */
  identityAlert?: IdentityAlert;
}

/** Upper bound on a reported URL — a self-report far longer than any real
 * siteurl is treated as no signal rather than parsed. Mirrored plugin-side. */
const MAX_URL_LEN = 2048;

/**
 * Canonicalize a WordPress-reported site URL for identity comparison: https/http
 * only, scheme+host lowercased, a single trailing FQDN dot dropped, default
 * ports dropped (by URL), trailing slash removed, query/fragment ignored. A path
 * IS part of identity (a subdirectory install `…/blog` differs from root).
 * Returns null for anything unparseable — the caller treats null as "no identity
 * signal", never as a mismatch.
 */
export function normalizeSiteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LEN) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const scheme = parsed.protocol.toLowerCase(); // includes trailing ':'
  // `victim.com` and `victim.com.` are the same DNS name — normalize a single
  // trailing dot away so a legitimate site isn't spuriously flagged.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  const host = parsed.port ? `${hostname}:${parsed.port}` : hostname;
  const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${scheme}//${host}${path}`;
}

export type IdentityDecision =
  /** Observed URL absent/unparseable AND the link was never bound — leave untouched. */
  | { kind: "no-signal" }
  /** First verified self-report — bind it (trust-on-first-report). */
  | { kind: "bound"; next: IdentityState }
  /** Reports the confirmed identity — no change. */
  | { kind: "match"; next: IdentityState }
  /** Valid-key link reports a DIFFERENT (or no longer any) canonical URL. */
  | { kind: "mismatch"; next: IdentityState };

/**
 * Decide the new identity fields from a signature-verified self-report.
 *
 * - Unparseable/absent report:
 *     · not yet bound ⇒ NO-SIGNAL (an older Connector that doesn't self-report).
 *     · already bound ⇒ MISMATCH `stopped-reporting`: a link that reported a URL
 *       before and now goes dark is itself suspicious (breaking `home` is the
 *       cheapest way to force "no signal"), so it enters safe mode instead of
 *       being silently exempted.
 * - No bound URL yet ⇒ BIND (the operator already fingerprint-confirmed at
 *   enrollment; the first verified self-report anchors the identity).
 * - Observed == bound ⇒ MATCH: no change. An existing suspension is left in
 *   place — only an operator re-confirm clears safe mode.
 * - Observed != bound ⇒ MISMATCH `url-changed`: suspend state-changing ops and
 *   record the latest observed URL. The confirmed `canonicalUrl` is kept until
 *   the operator explicitly accepts the new one (or quarantines/kills the link).
 */
export function evaluateIdentity(
  current: IdentityState,
  observedRaw: unknown,
  at: string,
): IdentityDecision {
  const observed = normalizeSiteUrl(observedRaw);

  if (observed === null) {
    if (!current.canonicalUrl) return { kind: "no-signal" };
    // Already suspended → don't churn the alert (keep the one the operator is
    // reviewing). Otherwise trip safe mode on the signal→no-signal regression.
    if (current.identitySuspended) return { kind: "match", next: { ...current } };
    return {
      kind: "mismatch",
      next: {
        canonicalUrl: current.canonicalUrl,
        identitySuspended: true,
        identityAlert: {
          reason: "stopped-reporting",
          observedUrl: "",
          boundUrl: current.canonicalUrl,
          at,
        },
      },
    };
  }

  const bound = current.canonicalUrl ? normalizeSiteUrl(current.canonicalUrl) : null;
  if (bound === null) {
    return {
      kind: "bound",
      next: { canonicalUrl: observed, identitySuspended: false, identityAlert: undefined },
    };
  }
  if (observed === bound) {
    return { kind: "match", next: { ...current } };
  }
  return {
    kind: "mismatch",
    next: {
      canonicalUrl: current.canonicalUrl,
      identitySuspended: true,
      identityAlert: { reason: "url-changed", observedUrl: observed, boundUrl: bound, at },
    },
  };
}

/**
 * Operator re-confirm: accept the observed identity that tripped safe mode as
 * the new binding and clear the suspension. For a `url-changed` alert this
 * rebinds to the new URL ("yes, the site legitimately moved"); for a
 * `stopped-reporting` alert there is no valid new URL, so the existing binding
 * is kept and only the suspension clears. Rejecting a suspected clone is
 * quarantine/kill, not this.
 */
export function confirmIdentity(current: IdentityState): IdentityState {
  const observed = current.identityAlert?.observedUrl;
  const normalized = observed ? normalizeSiteUrl(observed) : null;
  const accepted = normalized ?? current.canonicalUrl;
  return { canonicalUrl: accepted, identitySuspended: false, identityAlert: undefined };
}

/** True while the link is in identity safe mode. */
export function isIdentitySuspended(state: IdentityState): boolean {
  return state.identitySuspended === true;
}
