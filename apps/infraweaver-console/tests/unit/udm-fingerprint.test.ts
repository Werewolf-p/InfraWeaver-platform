import { fingerprintsMatch, normalizeFingerprint } from "@/lib/udm/fingerprint";

const OPENSSL = "13:8F:E3:EE:C6:34:B3:EB:DB:97:37:88:C1:88:E2:3F:5A:A4:99:E4:2C:66:32:30:9C:79:D6:A1:D7:F9:7B:F6";
const NODE = "13:8f:e3:ee:c6:34:b3:eb:db:97:37:88:c1:88:e2:3f:5a:a4:99:e4:2c:66:32:30:9c:79:d6:a1:d7:f9:7b:f6";
const BARE = "138fe3eec634b3ebdb973788c188e23f5aa499e42c6632309c79d6a1d7f97bf6";

describe("normalizeFingerprint", () => {
  it("strips colons and lowercases", () => {
    expect(normalizeFingerprint(OPENSSL)).toBe(BARE);
  });

  it("strips a sha256: prefix and whitespace", () => {
    expect(normalizeFingerprint(`  sha256:${OPENSSL}  `)).toBe(BARE);
  });
});

describe("fingerprintsMatch", () => {
  it("matches openssl and Node fingerprint spellings of the same cert", () => {
    expect(fingerprintsMatch(OPENSSL, NODE)).toBe(true);
  });

  it("matches bare hex against colon-hex", () => {
    expect(fingerprintsMatch(BARE, OPENSSL)).toBe(true);
  });

  it("rejects a different fingerprint", () => {
    const other = BARE.replace(/^13/, "99");
    expect(fingerprintsMatch(OPENSSL, other)).toBe(false);
  });

  it("fails closed on an empty or truncated pin", () => {
    expect(fingerprintsMatch(OPENSSL, "")).toBe(false);
    expect(fingerprintsMatch(OPENSSL, "138fe3")).toBe(false);
  });
});
