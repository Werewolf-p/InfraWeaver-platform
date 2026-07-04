/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALG_ED25519,
  ALG_SLHDSA,
  commandMessage,
  createSignedCommand,
  dualVerify,
  fromB64u,
  generateIwKeyPair,
  verifySignedResponse,
  type IwPublicKeys,
  type SignedCommand,
  type SignedResponse,
} from "@/lib/iwsl";

interface Fixtures {
  site_id: string;
  t0: number;
  keys: { iw_pub: IwPublicKeys; wp_pub: string };
  commands: Record<string, SignedCommand>;
  response: SignedResponse;
}

const fixtures: Fixtures = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../infraweaver-wp-connector/tests/fixtures/iwsl-fixtures.json"),
    "utf8",
  ),
);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("IWSL command dual signatures", () => {
  const iwPub = fixtures.keys.iw_pub;

  test("fixture command verifies under both algorithms", () => {
    const { envelope, sigs } = fixtures.commands.valid;
    expect(dualVerify(commandMessage(envelope), sigs, iwPub)).toEqual({ ok: true });
  });

  test("downgrade-strip: removing the PQ signature is rejected", () => {
    const stripped = clone(fixtures.commands.valid);
    delete stripped.sigs[ALG_SLHDSA];
    expect(dualVerify(commandMessage(stripped.envelope), stripped.sigs, iwPub)).toEqual({
      ok: false,
      reason: "pq-required",
    });
  });

  test("tampered envelope breaks both signatures", () => {
    const tampered = clone(fixtures.commands.valid);
    tampered.envelope.params = { privilege: "admin" };
    const verdict = dualVerify(commandMessage(tampered.envelope), tampered.sigs, iwPub);
    expect(verdict.ok).toBe(false);
  });

  test("corrupted SLH-DSA signature is rejected as bad-sig-pq", () => {
    const tampered = clone(fixtures.commands.valid);
    const sig = tampered.sigs[ALG_SLHDSA];
    tampered.sigs[ALG_SLHDSA] = (sig.startsWith("A") ? "B" : "A") + sig.slice(1);
    expect(dualVerify(commandMessage(tampered.envelope), tampered.sigs, iwPub)).toEqual({
      ok: false,
      reason: "bad-sig-pq",
    });
  });

  test(
    "live dual sign/verify round-trip (SLH-DSA-192s signing is slow)",
    () => {
      const keys = generateIwKeyPair({
        ed25519: new Uint8Array(32).fill(1),
        slhdsa: new Uint8Array(72).fill(2),
      });
      const signed = createSignedCommand(
        {
          siteId: "live-site",
          method: "health.check",
          params: {},
          seq: 1,
          kid: 1,
          ts: fixtures.t0,
        },
        keys,
      );
      const pub: IwPublicKeys = {
        [ALG_ED25519]: Buffer.from(keys.ed25519PublicKey).toString("base64url"),
        [ALG_SLHDSA]: Buffer.from(keys.slhdsaPublicKey).toString("base64url"),
      } as IwPublicKeys;
      expect(dualVerify(commandMessage(signed.envelope), signed.sigs, pub)).toEqual({ ok: true });
      expect(fromB64u(signed.sigs[ALG_SLHDSA]).length).toBe(16224);
    },
    120_000,
  );
});

describe("IWSL response verification (§6.2)", () => {
  const expectation = {
    siteId: fixtures.site_id,
    commandNonce: fixtures.commands.valid.envelope.nonce,
  };

  test("fixture response verifies and binds to the command nonce", () => {
    expect(verifySignedResponse(fixtures.response, fixtures.keys.wp_pub, expectation)).toEqual({
      ok: true,
    });
  });

  test("response for a different command nonce is rejected", () => {
    expect(
      verifySignedResponse(fixtures.response, fixtures.keys.wp_pub, {
        ...expectation,
        commandNonce: "some-other-nonce",
      }),
    ).toEqual({ ok: false, reason: "reply-mismatch" });
  });

  test("response from another site is rejected", () => {
    expect(
      verifySignedResponse(fixtures.response, fixtures.keys.wp_pub, {
        ...expectation,
        siteId: "other-site",
      }),
    ).toEqual({ ok: false, reason: "site-mismatch" });
  });

  test("MITM key substitution on responses fails signature check", () => {
    const attacker = generateIwKeyPair({
      ed25519: new Uint8Array(32).fill(9),
      slhdsa: new Uint8Array(72).fill(9),
    });
    const attackerPk = Buffer.from(attacker.ed25519PublicKey).toString("base64url");
    expect(verifySignedResponse(fixtures.response, attackerPk, expectation)).toEqual({
      ok: false,
      reason: "bad-sig-ed25519",
    });
  });

  test("oversized result rejected by byte ceiling", () => {
    expect(
      verifySignedResponse(fixtures.response, fixtures.keys.wp_pub, {
        ...expectation,
        maxResultBytes: 4,
      }),
    ).toEqual({ ok: false, reason: "result-too-large" });
  });

  test("tampered result payload breaks the signature", () => {
    const tampered = clone(fixtures.response);
    tampered.envelope.result = { status: "pwned" };
    const verdict = verifySignedResponse(tampered, fixtures.keys.wp_pub, expectation);
    expect(verdict).toEqual({ ok: false, reason: "bad-sig-ed25519" });
  });
});
