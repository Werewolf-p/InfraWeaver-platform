/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DOMAIN_ENROLL_PROOF,
  canonicalize,
  domainMessage,
  edSign,
  enrollBinding,
  fromB64u,
  generateWpKeyPair,
  toB64u,
  verifyEnrollProof,
  type EnrollProof,
  type PendingEnrollment,
  type SignedEnrollProof,
  type SignedEnrollmentBundle,
  type WpKeyPair,
} from "@/lib/iwsl";

interface Fixtures {
  site_id: string;
  t0: number;
  keys: { enroll_secret: string };
  enrollment: { signed: SignedEnrollmentBundle };
}

const fixtures: Fixtures = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../infraweaver-wp-connector/tests/fixtures/iwsl-fixtures.json"),
    "utf8",
  ),
);

const enrollSecret = fromB64u(fixtures.keys.enroll_secret);

function pending(): PendingEnrollment {
  return {
    siteId: fixtures.site_id,
    enrollSecret,
    expiresTs: fixtures.enrollment.signed.bundle.expires_ts,
  };
}

/** What an honest Connector publishes at /enroll-proof (§5 step 2). */
function honestProof(wpKeys: WpKeyPair, secret: Uint8Array): SignedEnrollProof {
  const wpPk = toB64u(wpKeys.ed25519PublicKey);
  const proof: EnrollProof = {
    v: 1,
    typ: "enroll-proof",
    site_id: fixtures.site_id,
    wp_pk: wpPk,
    ts: fixtures.t0 + 2000,
    binding: toB64u(enrollBinding(secret, fixtures.site_id, wpPk)),
  };
  const message = domainMessage(DOMAIN_ENROLL_PROOF, canonicalize(proof));
  return { proof, sigs: { ed25519: edSign(message, wpKeys.ed25519SecretKey) } };
}

describe("IWSL enrollment proof verification (§5 step 3)", () => {
  const siteKeys = generateWpKeyPair(new Uint8Array(32).fill(7));

  test("honest proof pins the site WP-PK", () => {
    const verdict = verifyEnrollProof(pending(), honestProof(siteKeys, enrollSecret), fixtures.t0 + 3000);
    expect(verdict).toEqual({ ok: true, wpPk: toB64u(siteKeys.ed25519PublicKey) });
  });

  test("MITM key substitution: attacker swaps WP-PK but cannot rebuild the binding", () => {
    const attackerKeys = generateWpKeyPair(new Uint8Array(32).fill(66));
    const honest = honestProof(siteKeys, enrollSecret);
    // Attacker intercepts the proof pull, substitutes their own key, re-signs
    // the document — but must keep the old binding (no enroll_secret).
    const forged: SignedEnrollProof = {
      proof: { ...honest.proof, wp_pk: toB64u(attackerKeys.ed25519PublicKey) },
      sigs: {},
    };
    const message = domainMessage(DOMAIN_ENROLL_PROOF, canonicalize(forged.proof));
    forged.sigs.ed25519 = edSign(message, attackerKeys.ed25519SecretKey);
    expect(verifyEnrollProof(pending(), forged, fixtures.t0 + 3000)).toEqual({
      ok: false,
      reason: "binding-mismatch",
    });
  });

  test("MITM with self-invented secret still fails — binding keyed by the real enroll_secret", () => {
    const attackerKeys = generateWpKeyPair(new Uint8Array(32).fill(67));
    const forged = honestProof(attackerKeys, new Uint8Array(32).fill(99));
    expect(verifyEnrollProof(pending(), forged, fixtures.t0 + 3000)).toEqual({
      ok: false,
      reason: "binding-mismatch",
    });
  });

  test("expired enrollment window is rejected", () => {
    const verdict = verifyEnrollProof(
      pending(),
      honestProof(siteKeys, enrollSecret),
      fixtures.enrollment.signed.bundle.expires_ts + 1,
    );
    expect(verdict).toEqual({ ok: false, reason: "enroll-expired" });
  });

  test("proof for another site is rejected", () => {
    const verdict = verifyEnrollProof(
      { ...pending(), siteId: "different-site" },
      honestProof(siteKeys, enrollSecret),
      fixtures.t0 + 3000,
    );
    expect(verdict).toEqual({ ok: false, reason: "site-mismatch" });
  });

  test("valid binding but wrong proof signature is rejected", () => {
    const otherKeys = generateWpKeyPair(new Uint8Array(32).fill(8));
    const honest = honestProof(siteKeys, enrollSecret);
    const badSig: SignedEnrollProof = {
      proof: honest.proof,
      sigs: {
        ed25519: edSign(
          domainMessage(DOMAIN_ENROLL_PROOF, canonicalize(honest.proof)),
          otherKeys.ed25519SecretKey,
        ),
      },
    };
    expect(verifyEnrollProof(pending(), badSig, fixtures.t0 + 3000)).toEqual({
      ok: false,
      reason: "bad-sig-ed25519",
    });
  });
});
