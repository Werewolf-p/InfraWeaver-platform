// IWSL v1 — InfraWeaver Site Link protocol types.
// Spec: docs/infraweaver-wp-remote-management-design.md (FINAL v1.2).
// Commands are dual-signed (Ed25519 + SLH-DSA-192s, AND semantics); responses are
// Ed25519-only. All numbers on the wire MUST be integers (§6.1 canonicalization
// restriction) so the JS and PHP canonicalizers can never diverge.

export const IWSL_VERSION = 1;

export const ALG_ED25519 = "ed25519";
export const ALG_SLHDSA = "slh-dsa-192s";

export const COMMAND_ALGS: readonly string[] = [ALG_ED25519, ALG_SLHDSA];
export const RESPONSE_ALGS: readonly string[] = [ALG_ED25519];

// Domain-separation tags (§6.1) — cross-protocol confusion defense.
export const DOMAIN_CMD = "IWSL-v1-cmd";
export const DOMAIN_RESP = "IWSL-v1-resp";
export const DOMAIN_ENROLL_BUNDLE = "IWSL-v1-enroll-bundle";
export const DOMAIN_ENROLL_PROOF = "IWSL-v1-enroll-proof";

// HMAC label for the enrollment binding (§5 step 2).
export const ENROLL_BINDING_LABEL = "IWSL-enroll-v1";

export const DEFAULT_COMMAND_TTL_MS = 120_000; // §6.3 exp default
export const DEFAULT_ENROLL_TTL_MS = 15 * 60_000; // §5 bundle TTL
export const DEFAULT_MAX_RESULT_BYTES = 262_144; // §6.2 byte ceiling

/** Transport a signed command is minted for (§6.4 channel binding). */
export type CommandChannel = "exec" | "https";

/**
 * Audience/channel binding (§6.4). Commits a command to the site it names AND
 * the transport it is meant to travel, so a captured-but-valid command can't be
 * redirected to a different channel (e.g. an exec-minted command replayed to the
 * public HTTPS endpoint) or a different site. `site` cross-checks `site_id`;
 * `chan` is enforced by the plugin against its own ingress; `spki` (external
 * HTTPS only) records the SPKI pin-set the console bound at send time — cert
 * enforcement itself is at the console TLS layer (the plugin can't observe its
 * own served cert), so `spki` is signed provenance layered on that pinning.
 */
export interface CommandAudience {
  site: string;
  chan: CommandChannel;
  spki?: string[];
}

export interface CommandEnvelope {
  v: number;
  typ: "cmd";
  site_id: string;
  nonce: string;
  seq: number;
  kid: number;
  ts: number;
  exp: number;
  method: string;
  params: Record<string, unknown>;
  alg: string[];
  /**
   * §6.4 channel/audience binding. Optional on the wire for a backward-compatible
   * rollout: a Connector that predates the binding verifies the (signed) field
   * but ignores it, and the field can't be stripped without breaking the
   * signature. Populated on every command a current console mints.
   */
  aud?: CommandAudience;
}

export interface ResponseEnvelope {
  v: number;
  typ: "resp";
  site_id: string;
  in_reply_to: string;
  kid: number;
  ts: number;
  ok: boolean;
  result: Record<string, unknown>;
  alg: string[];
}

/** Detached signatures, base64url, keyed by algorithm name. */
export interface SignatureSet {
  [alg: string]: string;
}

export interface SignedCommand {
  envelope: CommandEnvelope;
  sigs: SignatureSet;
}

export interface SignedResponse {
  envelope: ResponseEnvelope;
  sigs: SignatureSet;
}

/** IW cluster keypair — Ed25519 + SLH-DSA-192s (§4). */
export interface IwKeyPair {
  ed25519SecretKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  slhdsaSecretKey: Uint8Array;
  slhdsaPublicKey: Uint8Array;
}

/** IW public keys as pinned by the plugin (base64url). */
export interface IwPublicKeys {
  ed25519: string;
  "slh-dsa-192s": string;
}

/** Per-site WP keypair — Ed25519 only (v1.2, responses are classical-only). */
export interface WpKeyPair {
  ed25519SecretKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
}

export interface EnrollmentBundle {
  v: number;
  typ: "enroll-bundle";
  site_id: string;
  /** IW key epoch of iw_pk — the `kid` the plugin pins these keys under (§8). */
  iw_kid: number;
  iw_pk: IwPublicKeys;
  enroll_secret: string;
  created_ts: number;
  expires_ts: number;
  callback_origin: string;
  policy: "strict-pq";
}

export interface SignedEnrollmentBundle {
  bundle: EnrollmentBundle;
  sigs: SignatureSet;
}

export interface EnrollProof {
  v: number;
  typ: "enroll-proof";
  site_id: string;
  wp_pk: string;
  ts: number;
  binding: string;
}

export interface SignedEnrollProof {
  proof: EnrollProof;
  sigs: SignatureSet;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };
