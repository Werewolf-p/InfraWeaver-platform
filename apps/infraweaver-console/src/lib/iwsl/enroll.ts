// IWSL enrollment — IW side of §5 / §5.1.
// IW generates the sensitive .iwenroll bundle, later pulls the passive
// enroll-proof document from the site and verifies the HMAC binding before
// pinning WP-PK. The binding is what defeats MITM key substitution: a valid
// binding requires possession of enroll_secret, which never travels in the
// proof — only inside the operator-handled bundle.

import {
  constantTimeEqual,
  domainMessage,
  dualSign,
  edVerify,
  enrollBinding,
  fromB64u,
  iwPublicKeys,
  randomBytes,
  toB64u,
} from "./crypto";
import { canonicalize } from "./jcs";
import {
  ALG_ED25519,
  DEFAULT_ENROLL_TTL_MS,
  DOMAIN_ENROLL_BUNDLE,
  DOMAIN_ENROLL_PROOF,
  IWSL_VERSION,
  type EnrollmentBundle,
  type IwKeyPair,
  type SignedEnrollProof,
  type SignedEnrollmentBundle,
} from "./types";

export interface CreateBundleInput {
  siteId: string;
  callbackOrigin: string;
  now: number;
  /** Current IW key epoch (default 1). */
  iwKid?: number;
  ttlMs?: number;
  /** Test seam — production callers omit. */
  enrollSecret?: Uint8Array;
}

export interface CreatedEnrollment {
  signed: SignedEnrollmentBundle;
  /** Store server-side (pending site record); burn after verify (§5 step 3). */
  enrollSecret: Uint8Array;
}

export function createEnrollmentBundle(
  input: CreateBundleInput,
  keys: IwKeyPair,
): CreatedEnrollment {
  const enrollSecret = input.enrollSecret ?? randomBytes(32);
  const bundle: EnrollmentBundle = {
    v: IWSL_VERSION,
    typ: "enroll-bundle",
    site_id: input.siteId,
    iw_kid: input.iwKid ?? 1,
    iw_pk: iwPublicKeys(keys),
    enroll_secret: toB64u(enrollSecret),
    created_ts: input.now,
    expires_ts: input.now + (input.ttlMs ?? DEFAULT_ENROLL_TTL_MS),
    callback_origin: input.callbackOrigin,
    policy: "strict-pq",
  };
  const sigs = dualSign(domainMessage(DOMAIN_ENROLL_BUNDLE, canonicalize(bundle)), keys);
  return { signed: { bundle, sigs }, enrollSecret };
}

/** Serialize to the `.iwenroll` file the operator downloads (§5 step 1). */
export function serializeBundleFile(signed: SignedEnrollmentBundle): string {
  return `${JSON.stringify(signed)}\n`;
}

export function parseEnrollProof(text: string): SignedEnrollProof {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("proof" in parsed) ||
    !("sigs" in parsed)
  ) {
    throw new Error("IWSL: malformed enroll-proof document");
  }
  return parsed as SignedEnrollProof;
}

export interface PendingEnrollment {
  siteId: string;
  enrollSecret: Uint8Array;
  expiresTs: number;
}

export type EnrollProofResult =
  | { ok: true; wpPk: string }
  | { ok: false; reason: string };

/**
 * §5 step 3 — IW pulled the proof document; verify before pinning WP-PK.
 * On success the caller MUST mark the site ACTIVE, persist wpPk, and burn
 * the enroll_secret (single use).
 */
export function verifyEnrollProof(
  pending: PendingEnrollment,
  signedProof: SignedEnrollProof,
  now: number,
): EnrollProofResult {
  const { proof, sigs } = signedProof;
  if (
    typeof proof !== "object" ||
    proof === null ||
    proof.v !== IWSL_VERSION ||
    proof.typ !== "enroll-proof" ||
    typeof proof.wp_pk !== "string" ||
    typeof proof.binding !== "string" ||
    typeof proof.ts !== "number"
  ) {
    return { ok: false, reason: "schema-fail" };
  }
  if (proof.site_id !== pending.siteId) {
    return { ok: false, reason: "site-mismatch" };
  }
  if (now > pending.expiresTs) {
    return { ok: false, reason: "enroll-expired" };
  }
  const expectedBinding = enrollBinding(pending.enrollSecret, pending.siteId, proof.wp_pk);
  let claimedBinding: Uint8Array;
  try {
    claimedBinding = fromB64u(proof.binding);
  } catch {
    return { ok: false, reason: "schema-fail" };
  }
  if (!constantTimeEqual(expectedBinding, claimedBinding)) {
    // MITM / endpoint-reader key substitution: WP-PK not bound by enroll_secret.
    return { ok: false, reason: "binding-mismatch" };
  }
  const sig = sigs?.[ALG_ED25519];
  const message = domainMessage(DOMAIN_ENROLL_PROOF, canonicalize(proof));
  if (typeof sig !== "string" || !edVerify(message, sig, fromB64u(proof.wp_pk))) {
    return { ok: false, reason: "bad-sig-ed25519" };
  }
  return { ok: true, wpPk: proof.wp_pk };
}
