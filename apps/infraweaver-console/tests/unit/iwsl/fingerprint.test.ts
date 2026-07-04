/** @jest-environment node */
// Fingerprint rendering must be byte-identical to the Connector plugin
// (class-iwsl-cli.php::fingerprint) — the §5 step-3 defence is an operator
// comparing the two strings by eye, so any divergence silently breaks it.
// Expected values below were generated with the PHP implementation:
//   implode(':', str_split(substr(hash('sha256', $m), 0, 16), 4))

import {
  fingerprintKeyMaterial,
  iwKeysFingerprint,
  wpKeyFingerprint,
} from "@/lib/iwsl";

describe("IWSL fingerprints (PHP parity)", () => {
  test("hashes string material like the plugin", () => {
    // php: fp("EDKEYB64U" . "PQKEYB64U")
    expect(fingerprintKeyMaterial("EDKEYB64UPQKEYB64U")).toBe("b80f:c26c:b50e:56b7");
  });

  test("hashes raw bytes like the plugin", () => {
    // php: fp(hex2bin("000102…1f")) — the WP-PK case (raw 32-byte key)
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = i;
    expect(fingerprintKeyMaterial(bytes)).toBe("630d:cd29:66c4:3366");
  });

  test("empty material matches the SHA-256 empty digest prefix", () => {
    expect(fingerprintKeyMaterial("")).toBe("e3b0:c442:98fc:1c14");
  });

  test("iwKeysFingerprint concatenates the two pinned b64u strings", () => {
    // Plugin: fingerprint($iw_keys[ed25519] . $iw_keys[slh-dsa-192s]) where the
    // stored values are the bundle's b64u strings.
    const fp = iwKeysFingerprint({ ed25519: "EDKEYB64U", "slh-dsa-192s": "PQKEYB64U" });
    expect(fp).toBe("b80f:c26c:b50e:56b7");
  });

  test("wpKeyFingerprint hashes the decoded raw public key", () => {
    // Plugin: fingerprint($pair['pk']) over RAW bytes, not the b64u string.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = i;
    const b64u = Buffer.from(bytes).toString("base64url");
    expect(wpKeyFingerprint(b64u)).toBe("630d:cd29:66c4:3366");
  });

  test("format is four colon-separated groups of four lowercase hex chars", () => {
    expect(fingerprintKeyMaterial("anything")).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
  });
});
