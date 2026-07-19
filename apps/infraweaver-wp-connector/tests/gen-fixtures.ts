// Regenerates tests/fixtures/iwsl-fixtures.json — the cross-language test
// vectors signed by the IW TS lib and verified by the PHP Connector.
//
//   cd apps/infraweaver-console && npx tsx ../infraweaver-wp-connector/tests/gen-fixtures.ts
//
// Deterministic keys/values (TEST VECTORS ONLY — never reuse these seeds).
// SLH-DSA-192s signing is slow (~10s each); this script performs 9 signs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALG_ED25519,
  ALG_SLHDSA,
  canonicalize,
  commandMessage,
  createEnrollmentBundle,
  createSignedCommand,
  createSignedResponse,
  dualSign,
  generateIwKeyPair,
  generateWpKeyPair,
  iwPublicKeys,
  toB64u,
  type CommandChannel,
  type CommandEnvelope,
  type SignedCommand,
} from "../../infraweaver-console/src/lib/iwsl";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const SITE_ID = "site-fixture-1";
const T0 = 1751600000000;

const iwKeys = generateIwKeyPair({
  ed25519: new Uint8Array(32).fill(0x21),
  slhdsa: new Uint8Array(72).fill(0x42),
});
const wpKeys = generateWpKeyPair(new Uint8Array(32).fill(0x63));
const enrollSecret = new Uint8Array(32).fill(0x0f);

// Test-only SPKI pin (never a real cert). The plugin bounds aud.spki's SHAPE
// but doesn't verify the value, so a placeholder base64 exercises the binding.
const FIXTURE_SPKI = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

interface CommandInput {
  method: string;
  params: Record<string, unknown>;
  seq: number;
  ts: number;
  ttlMs?: number;
  nonce?: string;
  /** §6.4 channel to bind (default "exec" — the managed transport). */
  channel?: CommandChannel;
  spki?: string[];
}

function command(label: string, input: CommandInput): SignedCommand {
  process.stderr.write(`signing ${label}...\n`);
  return createSignedCommand(
    { siteId: SITE_ID, kid: 1, ...input },
    iwKeys,
  );
}

/**
 * A pre-§6.4 command with NO aud claim — proves the verifier accepts a legacy
 * (pre-binding) console over any channel, which is what makes the aud rollout
 * backward-compatible. Built envelope-first so the signature covers an envelope
 * that genuinely omits `aud` (not one with aud deleted afterward).
 */
function legacyCommand(label: string, input: CommandInput): SignedCommand {
  process.stderr.write(`signing ${label} (legacy, no aud)...\n`);
  const envelope: CommandEnvelope = {
    v: 1,
    typ: "cmd",
    site_id: SITE_ID,
    nonce: input.nonce ?? "legacy",
    seq: input.seq,
    kid: 1,
    ts: input.ts,
    exp: input.ts + (input.ttlMs ?? 120_000),
    method: input.method,
    params: input.params,
    alg: [ALG_ED25519, ALG_SLHDSA],
  };
  return { envelope, sigs: dualSign(commandMessage(envelope), iwKeys) };
}

const valid = command("valid", {
  method: "health.check",
  params: {},
  seq: 10,
  ts: T0,
  nonce: "fixture-nonce-valid-1",
});

const commands = {
  valid,
  seqRollback: command("seqRollback", {
    method: "health.check",
    params: {},
    seq: 9,
    ts: T0,
    nonce: "fixture-nonce-rollback",
  }),
  unknownMethod: command("unknownMethod", {
    method: "no.such.method",
    params: {},
    seq: 11,
    ts: T0,
    nonce: "fixture-nonce-unknown",
  }),
  schemaFail: command("schemaFail", {
    method: "health.check",
    params: { junk: 1 },
    seq: 12,
    ts: T0,
    nonce: "fixture-nonce-schema",
  }),
  staleTs: command("staleTs", {
    method: "health.check",
    params: {},
    seq: 13,
    ts: T0 - 600_000,
    nonce: "fixture-nonce-stale",
  }),
  expired: command("expired", {
    // ts inside the ±300s window at now=T0, but exp already passed.
    method: "health.check",
    params: {},
    seq: 14,
    ts: T0 - 200_000,
    ttlMs: 120_000,
    nonce: "fixture-nonce-expired",
  }),
  nonceReuse: command("nonceReuse", {
    // Higher seq than `valid`, but the SAME nonce → replayed-nonce.
    method: "health.check",
    params: {},
    seq: 15,
    ts: T0,
    nonce: "fixture-nonce-valid-1",
  }),
  rotatePrepare: command("rotatePrepare", {
    method: "key.rotate.self",
    params: { rotation_id: "fx-rot-1", new_kid: 2 },
    seq: 16,
    ts: T0,
    nonce: "fixture-nonce-rotate",
  }),
  rotateConfirm: command("rotateConfirm", {
    method: "key.rotate.confirm",
    params: { rotation_id: "fx-rot-1" },
    seq: 17,
    ts: T0,
    nonce: "fixture-nonce-confirm",
  }),
  debugStatus: command("debugStatus", {
    method: "debug.status",
    params: {},
    seq: 18,
    ts: T0,
    nonce: "fixture-nonce-debug",
  }),
  // Signed read-only telemetry (exec channel, no params) — same envelope shape
  // as health.check/debug.status. seq 19 slots between debug.status (18) and
  // site.deactivate (20) in the plugin flow; it shares seq 19 with httpsHealth
  // harmlessly, since httpsHealth is rejected at the channel check before seq.
  metricsSnapshot: command("metricsSnapshot", {
    method: "metrics.snapshot",
    params: {},
    seq: 19,
    ts: T0,
    nonce: "fixture-nonce-metrics",
  }),
  deactivate: command("deactivate", {
    method: "site.deactivate",
    params: {},
    seq: 20,
    ts: T0,
    nonce: "fixture-nonce-deactivate",
  }),
  // §6.4 channel binding: a health.check bound to the HTTPS transport (with an
  // SPKI provenance pin). Accepted over 'https', rejected 'channel-mismatch'
  // over 'exec'.
  httpsHealth: command("httpsHealth", {
    method: "health.check",
    params: {},
    seq: 19,
    ts: T0,
    nonce: "fixture-nonce-https",
    channel: "https",
    spki: [FIXTURE_SPKI],
  }),
  // §6.4 rollout: a command with no aud claim at all (legacy console).
  legacyNoAud: legacyCommand("legacyNoAud", {
    method: "health.check",
    params: {},
    seq: 21,
    ts: T0,
    nonce: "fixture-nonce-legacy",
  }),
};

process.stderr.write("signing enrollment bundle...\n");
const enrollment = createEnrollmentBundle(
  {
    siteId: SITE_ID,
    callbackOrigin: "https://wp.example.test",
    now: T0,
    iwKid: 1,
    enrollSecret,
  },
  iwKeys,
);

const response = createSignedResponse(
  {
    siteId: SITE_ID,
    inReplyTo: valid.envelope.nonce,
    kid: 1,
    ts: T0 + 1000,
    ok: true,
    result: { status: "ok" },
  },
  wpKeys,
);

const JCS_SAMPLES: unknown[] = [
  { b: 2, a: [1, "x", null, true], c: { z: 1, y: "é" } },
  {},
  { s: 'a"b\\c\n\té€', n: 0 },
  [[], {}, -5, false],
];

const fixtures = {
  generated_by: "apps/infraweaver-wp-connector/tests/gen-fixtures.ts",
  site_id: SITE_ID,
  t0: T0,
  keys: {
    iw_pub: iwPublicKeys(iwKeys),
    wp_pub: toB64u(wpKeys.ed25519PublicKey),
    wp_secret_seed: toB64u(wpKeys.ed25519SecretKey),
    enroll_secret: toB64u(enrollSecret),
  },
  jcs_vectors: JCS_SAMPLES.map((value) => ({ value, canon: canonicalize(value) })),
  commands,
  enrollment: { signed: enrollment.signed },
  response,
  // Standalone SLH-DSA vector for the pure-PHP verifier unit test — the PQ
  // signature of the `valid` command over its domain-separated message.
  slh_vector: {
    msg_b64: Buffer.from(commandMessage(valid.envelope)).toString("base64"),
    sig_b64u: valid.sigs["slh-dsa-192s"],
    pk_b64u: toB64u(iwKeys.slhdsaPublicKey),
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "iwsl-fixtures.json"), `${JSON.stringify(fixtures, null, 1)}\n`);
process.stderr.write("fixtures written\n");
