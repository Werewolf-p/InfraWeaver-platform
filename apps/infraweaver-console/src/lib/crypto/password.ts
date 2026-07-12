/**
 * Shared CSPRNG password generation.
 *
 * Consolidates the generators in `@/lib/app-accounts/password` (length 20,
 * unambiguous alphabet), `@/lib/nas/smb-accounts` (length 28) and
 * `@/lib/nas/mount-credentials` (affixed `Iw…7#` so every SMB complexity
 * class is present). Uses `crypto.randomInt`, which is rejection-sampled
 * internally, so every alphabet index is exactly uniform — no modulo skew
 * that would shrink the effective keyspace. Kept pure (no I/O) so its
 * entropy is unit-testable; never log the result.
 */
import { randomInt } from "node:crypto";

/**
 * Unambiguous alphabet: no 0/O, 1/l/I — easier to read and transcribe from a
 * vault reveal or a hand-off, and it removes the characters most often
 * mis-typed on TVs. (Same set as app-accounts/password.)
 */
export const UNAMBIGUOUS_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** Floor so a bad caller can never ask for a weak credential. */
const MIN_LENGTH = 16;
/** Reject tiny alphabets that would gut the keyspace (digits-only is the floor). */
const MIN_ALPHABET_SIZE = 10;
const DEFAULT_LENGTH = 20;
// Printable ASCII (no space): guards both charset sanity and the fact that
// string indexing below is per code unit.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export interface GeneratePasswordOptions {
  /** Number of RANDOM characters (default 20; must be >= 16). Affixes do not count. */
  length?: number;
  /** Character set (default {@link UNAMBIGUOUS_PASSWORD_ALPHABET}); >= 10 unique printable-ASCII chars. */
  alphabet?: string;
  /**
   * Literal characters placed around the random core, e.g.
   * `{ prefix: "Iw", suffix: "7#" }` to satisfy SMB complexity classes
   * (mount-credentials convention). Never part of the entropy budget.
   */
  affix?: { prefix?: string; suffix?: string };
}

/**
 * Cryptographically-random password: `prefix + <length random chars> + suffix`.
 * Throws (fail-fast) on a weak length, a too-small alphabet, duplicate
 * alphabet characters (which would bias the distribution), or non-ASCII
 * alphabet input.
 */
export function generatePassword(opts: GeneratePasswordOptions = {}): string {
  const length = opts.length ?? DEFAULT_LENGTH;
  const alphabet = opts.alphabet ?? UNAMBIGUOUS_PASSWORD_ALPHABET;

  if (!Number.isInteger(length) || length < MIN_LENGTH) {
    throw new Error(`password length must be an integer >= ${MIN_LENGTH}`);
  }
  if (!PRINTABLE_ASCII.test(alphabet)) {
    throw new Error("password alphabet must be non-empty printable ASCII (no spaces)");
  }
  if (new Set(alphabet).size !== alphabet.length) {
    throw new Error("password alphabet must not contain duplicate characters");
  }
  if (alphabet.length < MIN_ALPHABET_SIZE) {
    throw new Error(`password alphabet must contain at least ${MIN_ALPHABET_SIZE} unique characters`);
  }

  let core = "";
  for (let i = 0; i < length; i += 1) {
    core += alphabet[randomInt(alphabet.length)];
  }
  return `${opts.affix?.prefix ?? ""}${core}${opts.affix?.suffix ?? ""}`;
}
