// IWSL envelope construction and verification (§6).
// The command-verification state machine (seq/nonce/ts/kid) lives plugin-side in
// PHP — IW only builds commands and verifies responses.

import {
  domainMessage,
  dualSign,
  edSign,
  edVerify,
  fromB64u,
  randomBytes,
  toB64u,
} from "./crypto";
import { canonicalize } from "./jcs";
import {
  ALG_ED25519,
  COMMAND_ALGS,
  DEFAULT_COMMAND_TTL_MS,
  DEFAULT_MAX_RESULT_BYTES,
  DOMAIN_CMD,
  DOMAIN_RESP,
  IWSL_VERSION,
  RESPONSE_ALGS,
  type CommandEnvelope,
  type IwKeyPair,
  type ResponseEnvelope,
  type SignatureSet,
  type SignedCommand,
  type SignedResponse,
  type VerifyResult,
  type WpKeyPair,
} from "./types";

export interface CreateCommandInput {
  siteId: string;
  method: string;
  params: Record<string, unknown>;
  seq: number;
  kid: number;
  ts: number;
  ttlMs?: number;
  nonce?: string;
}

export function commandMessage(envelope: CommandEnvelope): Uint8Array {
  return domainMessage(DOMAIN_CMD, canonicalize(envelope));
}

export function responseMessage(envelope: ResponseEnvelope): Uint8Array {
  return domainMessage(DOMAIN_RESP, canonicalize(envelope));
}

export function createSignedCommand(input: CreateCommandInput, keys: IwKeyPair): SignedCommand {
  const envelope: CommandEnvelope = {
    v: IWSL_VERSION,
    typ: "cmd",
    site_id: input.siteId,
    nonce: input.nonce ?? toB64u(randomBytes(16)),
    seq: input.seq,
    kid: input.kid,
    ts: input.ts,
    exp: input.ts + (input.ttlMs ?? DEFAULT_COMMAND_TTL_MS),
    method: input.method,
    params: input.params,
    alg: [...COMMAND_ALGS],
  };
  return { envelope, sigs: dualSign(commandMessage(envelope), keys) };
}

export interface CreateResponseInput {
  siteId: string;
  inReplyTo: string;
  kid: number;
  ts: number;
  ok: boolean;
  result: Record<string, unknown>;
}

/** Response construction — used by tests and fixtures; production responses come from the PHP plugin. */
export function createSignedResponse(input: CreateResponseInput, keys: WpKeyPair): SignedResponse {
  const envelope: ResponseEnvelope = {
    v: IWSL_VERSION,
    typ: "resp",
    site_id: input.siteId,
    in_reply_to: input.inReplyTo,
    kid: input.kid,
    ts: input.ts,
    ok: input.ok,
    result: input.result,
    alg: [...RESPONSE_ALGS],
  };
  return { envelope, sigs: { [ALG_ED25519]: edSign(responseMessage(envelope), keys.ed25519SecretKey) } };
}

export interface VerifyResponseExpectation {
  siteId: string;
  /** Nonce of the outstanding command this response must answer (§6.2). */
  commandNonce: string;
  maxResultBytes?: number;
}

/**
 * Verify a site response (§6.2). Even on success the caller MUST treat
 * `result` as untrusted data: schema-validate per method, never eval,
 * escape at render.
 */
export function verifySignedResponse(
  signed: SignedResponse,
  wpPkB64u: string,
  expected: VerifyResponseExpectation,
): VerifyResult {
  const { envelope, sigs } = signed;
  if (!isPlainObject(envelope) || !isPlainObject(sigs)) {
    return { ok: false, reason: "schema-fail" };
  }
  if (envelope.v !== IWSL_VERSION || envelope.typ !== "resp") {
    return { ok: false, reason: "schema-fail" };
  }
  if (typeof envelope.ok !== "boolean" || !isPlainObject(envelope.result)) {
    return { ok: false, reason: "schema-fail" };
  }
  if (!Array.isArray(envelope.alg) || !sameAlgs(envelope.alg, RESPONSE_ALGS)) {
    return { ok: false, reason: "schema-fail" };
  }
  if (envelope.site_id !== expected.siteId) {
    return { ok: false, reason: "site-mismatch" };
  }
  if (envelope.in_reply_to !== expected.commandNonce) {
    return { ok: false, reason: "reply-mismatch" };
  }
  let message: Uint8Array;
  try {
    message = responseMessage(envelope);
  } catch {
    return { ok: false, reason: "schema-fail" };
  }
  const maxBytes = expected.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (canonicalize(envelope.result).length > maxBytes) {
    return { ok: false, reason: "result-too-large" };
  }
  const sig = sigs[ALG_ED25519];
  if (typeof sig !== "string" || !edVerify(message, sig, fromB64u(wpPkB64u))) {
    return { ok: false, reason: "bad-sig-ed25519" };
  }
  return { ok: true };
}

function sameAlgs(actual: readonly unknown[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((alg, index) => actual[index] === alg)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
