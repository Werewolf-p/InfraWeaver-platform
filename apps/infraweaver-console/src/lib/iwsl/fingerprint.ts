// IWSL key fingerprints — rendering MUST stay byte-identical to the Connector
// plugin (class-iwsl-cli.php::fingerprint): first 16 hex chars of SHA-256,
// ':'-joined groups of 4. The §5 step-3 MITM defence is an operator comparing
// these strings across both planes by eye, so the two implementations may
// never diverge. Both fingerprints hash RAW key bytes: the plugin's
// decode_iw_pks() b64u-decodes the bundle keys before pinning, so its stored
// iw_keys (like wp_keys) hold raw bytes, and CLI status fingerprints those.

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

/** IW-PK fingerprint as the plugin shows it: over `raw_ed25519 || raw_slhdsa`. */
export function iwKeysFingerprint(pks: IwPublicKeys): string {
  const ed = fromB64u(pks[ALG_ED25519]);
  const pq = fromB64u(pks[ALG_SLHDSA]);
  const material = new Uint8Array(ed.length + pq.length);
  material.set(ed, 0);
  material.set(pq, ed.length);
  return fingerprintKeyMaterial(material);
}

/** WP-PK fingerprint as the plugin shows it: over the raw decoded key bytes. */
export function wpKeyFingerprint(wpPkB64u: string): string {
  return fingerprintKeyMaterial(fromB64u(wpPkB64u));
}
