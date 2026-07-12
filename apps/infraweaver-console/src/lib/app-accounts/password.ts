/**
 * CSPRNG password generation for provisioned app accounts.
 *
 * A thin domain-named wrapper over the shared generator
 * (`@/lib/crypto/password`), keeping this module's defaults: 20 random
 * characters from the unambiguous alphabet (no 0/O, 1/l/I — easier to read and
 * transcribe from a vault reveal or a hand-off). Sampling is exactly uniform —
 * no modulo skew that would shrink the effective keyspace. Never logged; the
 * caller persists it to OpenBao and hands it to the notifier once.
 */
import { generatePassword } from "@/lib/crypto/password";

/**
 * Cryptographically-random password from the unambiguous alphabet. Throws on a
 * length below the shared 16-character floor, so a bad caller can't ask for a
 * weak credential.
 */
export function generateAppPassword(length = 20): string {
  return generatePassword({ length });
}
