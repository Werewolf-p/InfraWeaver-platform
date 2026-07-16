import { describe, expect, it } from "@jest/globals";
import { classifyClientError } from "@/lib/error-taxonomy";

describe("classifyClientError", () => {
  it("maps 401 to an expired session (not retryable)", () => {
    const c = classifyClientError({ status: 401 });
    expect(c.kind).toBe("unauthorized");
    expect(c.retryable).toBe(false);
  });

  it("maps 403 to forbidden", () => {
    expect(classifyClientError({ status: 403 }).kind).toBe("forbidden");
  });

  it("maps 503 to unavailable and retryable", () => {
    const c = classifyClientError({ status: 503 });
    expect(c.kind).toBe("unavailable");
    expect(c.retryable).toBe(true);
  });

  it("maps 429 to rate-limited and retryable", () => {
    expect(classifyClientError({ status: 429 })).toMatchObject({ kind: "rateLimited", retryable: true });
  });

  it("maps a network code to unavailable", () => {
    expect(classifyClientError({ code: "ECONNREFUSED" }).kind).toBe("unavailable");
  });

  it("maps an AbortError to timeout", () => {
    const err = new Error("The operation timed out");
    expect(classifyClientError(err).kind).toBe("timeout");
  });

  it("surfaces a 4xx app error message", () => {
    const c = classifyClientError(Object.assign(new Error("Name already taken"), { status: 409 }));
    expect(c.kind).toBe("app");
    expect(c.title).toBe("Name already taken");
    expect(c.retryable).toBe(false);
  });

  it("falls back to unknown with the error message", () => {
    expect(classifyClientError(new Error("boom"))).toMatchObject({ kind: "unknown", title: "boom" });
  });

  it("walks the cause chain for a wrapped fetch failure", () => {
    const c = classifyClientError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    expect(c.kind).toBe("unavailable");
  });
});
