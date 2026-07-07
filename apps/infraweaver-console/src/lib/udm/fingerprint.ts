/**
 * Certificate-fingerprint helpers for UDM cert pinning.
 *
 * The UDM presents a self-signed cert, so ordinary CA validation is not
 * possible. Instead we pin the exact server cert by its SHA-256 fingerprint.
 * These pure helpers normalize the many textual forms a fingerprint arrives in
 * (openssl `AA:BB:..`, Node `getPeerCertificate().fingerprint256`, or bare hex)
 * and compare them safely.
 */

/**
 * Reduce a fingerprint to a canonical lowercase hex string with no separators.
 * Accepts colon-, space-, or dash-separated hex and an optional `sha256:` prefix.
 */
export function normalizeFingerprint(fp: string): string {
  return fp
    .trim()
    .replace(/^sha-?256[:=]/i, "")
    .replace(/[\s:\-]/g, "")
    .toLowerCase();
}

/** True when both fingerprints are non-empty and equal after normalization. */
export function fingerprintsMatch(a: string, b: string): boolean {
  const na = normalizeFingerprint(a);
  const nb = normalizeFingerprint(b);
  // A SHA-256 fingerprint is 64 hex chars; reject anything shorter so a blank
  // or truncated pin can never accidentally match.
  if (na.length !== 64 || nb.length !== 64) return false;
  return na === nb;
}
