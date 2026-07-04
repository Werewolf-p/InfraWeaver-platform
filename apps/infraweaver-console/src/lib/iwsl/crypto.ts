// IWSL crypto primitives — dual sign/verify (Ed25519 + SLH-DSA-192s), domain
// separation, enrollment HMAC binding. Pure JS via @noble — no native deps, so
// the same code runs in the console, the future signer service, and jest.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha384 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { slh_dsa_sha2_192s } from "@noble/post-quantum/slh-dsa.js";

import {
  ALG_ED25519,
  ALG_SLHDSA,
  ENROLL_BINDING_LABEL,
  type IwKeyPair,
  type IwPublicKeys,
  type SignatureSet,
  type VerifyResult,
  type WpKeyPair,
} from "./types";

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const utf8 = new TextEncoder();

export const SLHDSA_SEED_BYTES = 72; // 3n for n=24 (SLH-DSA-192s)

export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64u(text: string): Uint8Array {
  if (!B64URL_RE.test(text)) {
    throw new Error("IWSL: invalid base64url input");
  }
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** `tag || 0x00 || canonicalJson` — §6.1 domain separation. */
export function domainMessage(tag: string, canonicalJson: string): Uint8Array {
  const tagBytes = utf8.encode(tag);
  const bodyBytes = utf8.encode(canonicalJson);
  const message = new Uint8Array(tagBytes.length + 1 + bodyBytes.length);
  message.set(tagBytes, 0);
  message[tagBytes.length] = 0x00;
  message.set(bodyBytes, tagBytes.length + 1);
  return message;
}

export function generateIwKeyPair(seed?: {
  ed25519?: Uint8Array;
  slhdsa?: Uint8Array;
}): IwKeyPair {
  const edSecret = seed?.ed25519 ?? randomBytes(32);
  const slhKeys = slh_dsa_sha2_192s.keygen(seed?.slhdsa ?? randomBytes(SLHDSA_SEED_BYTES));
  return {
    ed25519SecretKey: edSecret,
    ed25519PublicKey: ed25519.getPublicKey(edSecret),
    slhdsaSecretKey: slhKeys.secretKey,
    slhdsaPublicKey: slhKeys.publicKey,
  };
}

export function generateWpKeyPair(seed?: Uint8Array): WpKeyPair {
  const edSecret = seed ?? randomBytes(32);
  return {
    ed25519SecretKey: edSecret,
    ed25519PublicKey: ed25519.getPublicKey(edSecret),
  };
}

export function iwPublicKeys(keys: IwKeyPair): IwPublicKeys {
  return {
    [ALG_ED25519]: toB64u(keys.ed25519PublicKey),
    [ALG_SLHDSA]: toB64u(keys.slhdsaPublicKey),
  } as IwPublicKeys;
}

/** Sign with BOTH algorithms (commands, enrollment bundles — §6.1 AND semantics). */
export function dualSign(message: Uint8Array, keys: IwKeyPair): SignatureSet {
  return {
    [ALG_ED25519]: toB64u(ed25519.sign(message, keys.ed25519SecretKey)),
    [ALG_SLHDSA]: toB64u(slh_dsa_sha2_192s.sign(message, keys.slhdsaSecretKey)),
  };
}

/** Verify BOTH signatures. Either missing or invalid → reject (fail closed). */
export function dualVerify(
  message: Uint8Array,
  sigs: SignatureSet,
  publicKeys: IwPublicKeys,
): VerifyResult {
  const edSig = sigs[ALG_ED25519];
  const pqSig = sigs[ALG_SLHDSA];
  if (typeof pqSig !== "string" || pqSig.length === 0) {
    return { ok: false, reason: "pq-required" };
  }
  if (typeof edSig !== "string" || edSig.length === 0) {
    return { ok: false, reason: "bad-sig-ed25519" };
  }
  if (!edVerify(message, edSig, fromB64u(publicKeys[ALG_ED25519]))) {
    return { ok: false, reason: "bad-sig-ed25519" };
  }
  if (!slhVerify(message, pqSig, fromB64u(publicKeys[ALG_SLHDSA]))) {
    return { ok: false, reason: "bad-sig-pq" };
  }
  return { ok: true };
}

export function edSign(message: Uint8Array, secretKey: Uint8Array): string {
  return toB64u(ed25519.sign(message, secretKey));
}

export function edVerify(message: Uint8Array, sigB64u: string, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(fromB64u(sigB64u), message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

function slhVerify(message: Uint8Array, sigB64u: string, publicKey: Uint8Array): boolean {
  try {
    return slh_dsa_sha2_192s.verify(fromB64u(sigB64u), message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Enrollment binding (§5 step 2):
 * HMAC-SHA-384(enroll_secret, label || 0x00 || site_id || 0x00 || wp_pk_b64u).
 * 0x00 separators remove concatenation ambiguity; PHP mirrors byte-for-byte.
 */
export function enrollBinding(
  enrollSecret: Uint8Array,
  siteId: string,
  wpPkB64u: string,
): Uint8Array {
  const label = utf8.encode(ENROLL_BINDING_LABEL);
  const site = utf8.encode(siteId);
  const pk = utf8.encode(wpPkB64u);
  const data = new Uint8Array(label.length + 1 + site.length + 1 + pk.length);
  data.set(label, 0);
  data.set(site, label.length + 1);
  data.set(pk, label.length + 1 + site.length + 1);
  return hmac(sha384, enrollSecret, data);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export { randomBytes };
