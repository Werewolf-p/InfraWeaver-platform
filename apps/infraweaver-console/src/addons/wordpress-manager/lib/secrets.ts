import { randomBytes } from "node:crypto";

// Unambiguous alphabet: no 0/O, 1/l/I — easier to read and transcribe from the vault.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const WP_SALT_KEYS = [
  "AUTH_KEY",
  "SECURE_AUTH_KEY",
  "LOGGED_IN_KEY",
  "NONCE_KEY",
  "AUTH_SALT",
  "SECURE_AUTH_SALT",
  "LOGGED_IN_SALT",
  "NONCE_SALT",
] as const;

export type WpSaltKey = (typeof WP_SALT_KEYS)[number];

export interface SiteSecrets {
  db: {
    database: string;
    user: string;
    password: string;
    rootPassword: string;
  };
  wp: {
    adminPassword: string;
    salts: Record<WpSaltKey, string>;
  };
}

/**
 * Cryptographically-random password from an unambiguous alphabet (no O/0, I/l).
 * Rejection-sampled so the alphabet bias is exactly uniform — no modulo skew.
 */
export function generatePassword(length = 32): string {
  if (length <= 0) throw new Error("password length must be positive");
  const max = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** The eight WordPress auth salts, each a long random string. */
export function generateWpSalts(): Record<WpSaltKey, string> {
  return Object.fromEntries(WP_SALT_KEYS.map((key) => [key, generatePassword(48)])) as Record<WpSaltKey, string>;
}

/**
 * Generate every secret a site needs in one shot. Pure given the RNG; the caller
 * persists the result to the vault and projects it into k8s Secrets — it is never
 * returned to a client or written into a manifest.
 */
export function generateSiteSecrets(site: string): SiteSecrets {
  return {
    db: {
      database: `wp_${site.replace(/-/g, "_")}`,
      user: `wp_${site.replace(/-/g, "_")}`,
      password: generatePassword(32),
      rootPassword: generatePassword(32),
    },
    wp: {
      adminPassword: generatePassword(24),
      salts: generateWpSalts(),
    },
  };
}

/** Deterministic OpenBao paths for a site's secret trees. */
export function vaultPaths(site: string) {
  return {
    db: `secret/wordpress/${site}/db`,
    wp: `secret/wordpress/${site}/wp`,
    authentik: `secret/wordpress/${site}/authentik`,
    config: `secret/wordpress/${site}/config`,
  } as const;
}

/** Map a site's secrets onto the flat key/value pairs each vault path holds. */
export function vaultData(secrets: SiteSecrets) {
  return {
    db: {
      database: secrets.db.database,
      user: secrets.db.user,
      password: secrets.db.password,
      rootPassword: secrets.db.rootPassword,
    },
    wp: {
      adminPassword: secrets.wp.adminPassword,
      ...secrets.wp.salts,
    },
  };
}
