// IWSL key fingerprints — rendering MUST stay byte-identical to the Connector
// plugin (class-iwsl-cli.php::fingerprint): first 16 hex chars of SHA-256,
// ':'-joined groups of 4. The §5 step-3 MITM defence is an operator comparing
// these strings across both planes by eye, so the two implementations may
// never diverge. Note the plugin's asymmetry, preserved here: the IW
// fingerprint hashes the two pinned *b64u strings* concatenated, while the WP
// fingerprint hashes the *raw* public-key bytes.

import { sha256 } from "@noble/hashes/sha2.js";

import { fromB64u } from "./crypto";
import { ALG_ED25519, ALG_SLHDSA, type IwPublicKeys } from "./types";

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256(material)[0..16)` in ':'-groups of 4 — the shared display format. */
export function fingerprintKeyMaterial(material: Uint8Array | string): string {
  const bytes = typeof material === "string" ? utf8.encode(material) : material;
  const hex = toHex(sha256(bytes)).slice(0, 16);
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)].join(":");
}

/** IW-PK fingerprint as the plugin shows it: over `ed25519_b64u || slhdsa_b64u`. */
export function iwKeysFingerprint(pks: IwPublicKeys): string {
  return fingerprintKeyMaterial(`${pks[ALG_ED25519]}${pks[ALG_SLHDSA]}`);
}

/** WP-PK fingerprint as the plugin shows it: over the raw decoded key bytes. */
export function wpKeyFingerprint(wpPkB64u: string): string {
  return fingerprintKeyMaterial(fromB64u(wpPkB64u));
}
