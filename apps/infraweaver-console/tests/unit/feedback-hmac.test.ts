// Guards C2 (SECURITY-SCAN-2026-07-08): the canonical feedback endpoint's
// cross-deployment ("upstream") ingest path used to be gated by a plain,
// client-settable header (`x-infraweaver-upstream: 1`) that bypassed auth and
// chained into an auto-deploy coding agent. It is now gated by a shared HMAC.
// These tests pin the verifier: fail-closed, constant-time, replay-windowed.

jest.mock("server-only", () => ({}), { virtual: true });

import { signHmac, verifyHmac, HMAC_SKEW_MS } from "@/lib/hmac";

const SECRET = "shared-fork-canonical-secret";
const NOW = 1_700_000_000_000;

/** Build the headers a legitimate fork would send for `body` at time `ts`. */
function signedHeaders(body: string, ts: number, secret = SECRET) {
  const timestamp = String(ts);
  return { timestamp, signature: signHmac(`${timestamp}.${body}`, secret) };
}

describe("verifyHmac — upstream feedback signature", () => {
  const body = JSON.stringify({ description: "bug", type: "bug", pagePath: "/x" });

  it("accepts a correctly-signed request within the skew window", () => {
    const { timestamp, signature } = signedHeaders(body, NOW);
    expect(verifyHmac({ timestamp, signature, rawBody: body, secret: SECRET, now: NOW })).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const { timestamp, signature } = signedHeaders(body, NOW);
    const tampered = JSON.stringify({ description: "rm -rf /", type: "bug", pagePath: "/x" });
    expect(verifyHmac({ timestamp, signature, rawBody: tampered, secret: SECRET, now: NOW })).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const { timestamp, signature } = signedHeaders(body, NOW, "attacker-guess");
    expect(verifyHmac({ timestamp, signature, rawBody: body, secret: SECRET, now: NOW })).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    const { timestamp, signature } = signedHeaders(body, NOW, "");
    expect(verifyHmac({ timestamp, signature, rawBody: body, secret: "", now: NOW })).toBe(false);
  });

  it("rejects missing timestamp or signature headers", () => {
    const { timestamp, signature } = signedHeaders(body, NOW);
    expect(verifyHmac({ timestamp: null, signature, rawBody: body, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyHmac({ timestamp, signature: null, rawBody: body, secret: SECRET, now: NOW })).toBe(false);
  });

  it("rejects a replayed request outside the skew window (both directions)", () => {
    const { timestamp, signature } = signedHeaders(body, NOW);
    const past = NOW + HMAC_SKEW_MS + 1_000;
    const future = NOW - HMAC_SKEW_MS - 1_000;
    expect(verifyHmac({ timestamp, signature, rawBody: body, secret: SECRET, now: past })).toBe(false);
    expect(verifyHmac({ timestamp, signature, rawBody: body, secret: SECRET, now: future })).toBe(false);
  });

  it("accepts a request at the edge of the skew window", () => {
    const { timestamp, signature } = signedHeaders(body, NOW);
    expect(verifyHmac({ timestamp, signature, rawBody: body, secret: SECRET, now: NOW + HMAC_SKEW_MS })).toBe(true);
  });

  it("rejects a non-numeric timestamp", () => {
    const signature = signHmac(`not-a-number.${body}`, SECRET);
    expect(verifyHmac({ timestamp: "not-a-number", signature, rawBody: body, secret: SECRET, now: NOW })).toBe(false);
  });

  it("rejects a malformed (non-hex / wrong-length) signature without throwing", () => {
    const { timestamp } = signedHeaders(body, NOW);
    expect(verifyHmac({ timestamp, signature: "zzzz", rawBody: body, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyHmac({ timestamp, signature: "", rawBody: body, secret: SECRET, now: NOW })).toBe(false);
  });
});
