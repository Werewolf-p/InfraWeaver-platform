import { isRetryableInfraError } from "@/lib/retryable-error";

describe("isRetryableInfraError", () => {
  it("treats Node fetch socket failures as transient", () => {
    // Node's fetch wraps the underlying socket error as a TypeError with a cause.
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(isRetryableInfraError(err)).toBe(true);
  });

  it("treats Kubernetes gateway 5xx / 429 responses as transient", () => {
    expect(isRetryableInfraError({ statusCode: 503 })).toBe(true);
    expect(isRetryableInfraError({ code: 429 })).toBe(true);
  });

  it("treats our own request timeout (AbortError) as transient", () => {
    expect(isRetryableInfraError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("matches transient signatures in the message text", () => {
    expect(isRetryableInfraError(new Error("connect ECONNREFUSED 10.0.0.1:443"))).toBe(true);
    expect(isRetryableInfraError(new Error("Client network socket disconnected"))).toBe(true);
  });

  it("does NOT treat genuine application errors as transient", () => {
    expect(isRetryableInfraError(new Error("configmap not found"))).toBe(false);
    expect(isRetryableInfraError({ statusCode: 409 })).toBe(false);
    expect(isRetryableInfraError(new Error("Nothing to publish"))).toBe(false);
    expect(isRetryableInfraError(undefined)).toBe(false);
  });
});
