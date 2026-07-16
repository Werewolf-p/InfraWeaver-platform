import { fingerprint, stripVolatileSuffix } from "@/lib/notifications/fingerprint";
import type { RawSignal } from "@/lib/notifications/types";

function makeSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    key: "evt-1",
    app: "wordpress",
    cause: "BackOff",
    reason: "BackOff",
    object: "Pod/blog-7d9f8b2c1a-abcde",
    namespace: "wordpress",
    title: "BackOff · Pod/blog",
    level: "warning",
    timestamp: 1000,
    ...overrides,
  };
}

describe("stripVolatileSuffix", () => {
  it("removes deployment replicaset + pod hash suffixes", () => {
    expect(stripVolatileSuffix("blog-7d9f8b2c1a-abcde")).toBe("blog");
  });

  it("removes a bare pod hash suffix", () => {
    expect(stripVolatileSuffix("blog-abcde")).toBe("blog");
  });

  it("removes a statefulset ordinal suffix", () => {
    expect(stripVolatileSuffix("web-0")).toBe("web");
  });
});

describe("fingerprint", () => {
  it("produces the same fingerprint for the same reason and object", () => {
    // Arrange
    const a = makeSignal({ key: "evt-a" });
    const b = makeSignal({ key: "evt-b" });

    // Act / Assert — the volatile key differs but the fingerprint matches.
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("ignores volatile pod-hash suffixes when fingerprinting", () => {
    // Arrange — two pods of the same deployment, different hashes.
    const podOne = makeSignal({ object: "Pod/blog-7d9f8b2c1a-abcde" });
    const podTwo = makeSignal({ object: "Pod/blog-1a2b3c4d5e-fghij" });

    // Act / Assert
    expect(fingerprint(podOne)).toBe(fingerprint(podTwo));
  });

  it("produces different fingerprints for different causes", () => {
    const backoff = makeSignal({ cause: "BackOff", reason: "BackOff" });
    const unhealthy = makeSignal({ cause: "Unhealthy", reason: "Unhealthy" });

    expect(fingerprint(backoff)).not.toBe(fingerprint(unhealthy));
  });
});
