/**
 * Shared SHA-256 certificate-fingerprint helpers.
 *
 * Consolidates `@/lib/udm/fingerprint` and the pin normalization in
 * `@/lib/nas/pinned-fetch`. Fingerprints arrive in many textual forms —
 * openssl `AA:BB:…`, Node `getPeerCertificate().fingerprint256`, a
 * `sha256:` prefix, or bare hex — and all pinning decisions must reduce them
 * to one canonical form first.
 *
 * FAIL-CLOSED: `normalize` throws on anything that is not exactly 64 hex
 * characters after separator stripping, so a blank or truncated pin can never
 * accidentally match; `match` returns false instead of throwing.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Reduce a fingerprint to the canonical form: 64 lowercase hex chars, no
 * separators. Accepts colon-, space-, or dash-separated hex and an optional
 * `sha256:`/`SHA-256=` prefix. STRICT: throws when the remainder is not
 * exactly 64 hex characters.
 */
export function normalize(fp: string): string {
  const canonical = fp
    .trim()
    .replace(/^sha-?256[:=]/i, "")
    .replace(/[\s:\-]/g, "")
    .toLowerCase();
  if (!SHA256_HEX.test(canonical)) throw new Error("Invalid SHA-256 fingerprint");
  return canonical;
}

/**
 * Operator-facing display form: uppercase hex pairs joined by colons
 * (`AA:BB:…`), matching openssl and the NAS pin UI. Throws on invalid input
 * (same strictness as {@link normalize}).
 */
export function format(fp: string): string {
  const pairs = normalize(fp).toUpperCase().match(/.{2}/g) ?? [];
  return pairs.join(":");
}

/**
 * True when both fingerprints normalize to the same 64-hex value. FAIL-CLOSED:
 * any malformed, blank, or truncated input returns false rather than throwing,
 * so a bad pin can never match.
 */
export function match(a: string, b: string): boolean {
  try {
    return normalize(a) === normalize(b);
  } catch {
    return false;
  }
}
