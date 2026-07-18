/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";
import {
  ALG_ED25519,
  ALG_SLHDSA_192F,
  ALG_SLHDSA_192S,
  createSignedCommand,
  domainMessage,
  dualSign,
  dualVerify,
  generateIwKeyPair,
  iwPublicKeys,
} from "@/lib/iwsl";

const msg = domainMessage("IWSL-v1-test", '{"x":1}');

describe("SLH-DSA 192f alg-aware dual-accept", () => {
  const keys = generateIwKeyPair();

  it("signs+verifies a 192f command round-trip", () => {
    const sigs = dualSign(msg, keys, ALG_SLHDSA_192F);
    expect(typeof sigs[ALG_SLHDSA_192F]).toBe("string");
    expect(sigs[ALG_SLHDSA_192S]).toBeUndefined();
    expect(dualVerify(msg, sigs, iwPublicKeys(keys, ALG_SLHDSA_192F)).ok).toBe(true);
  });

  it("still signs+verifies a 192s command round-trip (back-compat)", () => {
    const sigs = dualSign(msg, keys, ALG_SLHDSA_192S);
    expect(dualVerify(msg, sigs, iwPublicKeys(keys, ALG_SLHDSA_192S)).ok).toBe(true);
  });

  it("rejects a 192f signature against a 192s-pinned key (no cross-accept)", () => {
    const sigs = dualSign(msg, keys, ALG_SLHDSA_192F);
    const verdict = dualVerify(msg, sigs, iwPublicKeys(keys, ALG_SLHDSA_192S));
    expect(verdict.ok).toBe(false);
  });

  it("rejects a 192s signature against a 192f-pinned link (downgrade defense)", () => {
    const sigs = dualSign(msg, keys, ALG_SLHDSA_192S);
    const verdict = dualVerify(msg, sigs, iwPublicKeys(keys, ALG_SLHDSA_192F));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("pq-required");
  });

  it("createSignedCommand declares the chosen alg in envelope.alg", () => {
    const cmd = createSignedCommand(
      { siteId: "s", method: "health.check", params: {}, seq: 1, kid: 1, ts: 1000 },
      keys,
      ALG_SLHDSA_192F,
    );
    expect(cmd.envelope.alg).toEqual([ALG_ED25519, ALG_SLHDSA_192F]);
    expect(typeof cmd.sigs[ALG_SLHDSA_192F]).toBe("string");
  });
});
