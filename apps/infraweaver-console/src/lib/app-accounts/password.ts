/**
 * CSPRNG password generation for provisioned app accounts.
 *
 * A generic copy of the WordPress addon's generator (`addons/wordpress-manager/
 * lib/secrets.ts#generatePassword`) rather than an import: core `lib` must not
 * depend on an addon, and this capability is app-agnostic. Kept pure so its
 * entropy is unit-testable with no I/O.
 */
import { randomBytes } from "node:crypto";

// Unambiguous alphabet: no 0/O, 1/l/I — easier to read and transcribe from a vault
// reveal or a hand-off, and it removes the characters most often mis-typed on TVs.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** Longest local password some clients accept without truncation, and the shortest
 *  we will ever mint — a floor so a bad caller can't ask for a weak credential. */
const MIN_LENGTH = 16;

/**
 * Cryptographically-random password from the unambiguous alphabet. Rejection-
 * sampled so the alphabet bias is exactly uniform — no modulo skew that would
 * shrink the effective keyspace. Never logged; the caller persists it to OpenBao
 * and hands it to the notifier once.
 */
export function generateAppPassword(length = 20): string {
  if (length < MIN_LENGTH) throw new Error(`app password length must be >= ${MIN_LENGTH}`);
  const max = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue; // reject the biased tail
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
