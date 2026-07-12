/**
 * Certificate-fingerprint helpers for UDM cert pinning.
 *
 * The UDM presents a self-signed cert, so ordinary CA validation is not
 * possible. Instead we pin the exact server cert by its SHA-256 fingerprint.
 * Thin wrappers over the shared canonicalizer (`@/lib/crypto/cert-fingerprint`),
 * which normalizes the many textual forms a fingerprint arrives in (openssl
 * `AA:BB:..`, Node `getPeerCertificate().fingerprint256`, or bare hex).
 */
import { match, normalize } from "@/lib/crypto/cert-fingerprint";

/**
 * Reduce a fingerprint to a canonical lowercase hex string with no separators.
 * Accepts colon-, space-, or dash-separated hex and an optional `sha256:`
 * prefix. STRICT: throws when the input is not a SHA-256 digest.
 */
export function normalizeFingerprint(fp: string): string {
  return normalize(fp);
}

/** True when both fingerprints are valid and equal after normalization. Fails
 *  closed: a blank or truncated pin can never accidentally match. */
export function fingerprintsMatch(a: string, b: string): boolean {
  return match(a, b);
}
