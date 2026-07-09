// Guards C2 (SECURITY-SCAN-2026-07-08) follow-up: the HMAC-gated upstream
// feedback ingest in the /api/feedback route handler is UNREACHABLE unless the
// middleware (proxy.ts) lets a *signed* cross-deployment POST past the session +
// CSRF gates — a genuine fork forward is anonymous and carries no same-origin
// Origin. hasUpstreamFeedbackSignature is that middleware gate predicate:
// presence of BOTH feedback HMAC headers. It grants NO trust — the route handler
// still verifies the HMAC and fails closed on a forged/expired signature
// (defence in depth, mirroring the health-sweep token bypass).

import { hasUpstreamFeedbackSignature } from "@/lib/api-helpers";

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) };
}

describe("hasUpstreamFeedbackSignature — middleware upstream-feedback gate", () => {
  it("is true when both x-iw-timestamp and x-iw-signature are present", () => {
    expect(
      hasUpstreamFeedbackSignature(req({ "x-iw-timestamp": "1700000000000", "x-iw-signature": "abcd" })),
    ).toBe(true);
  });

  it("is false when the signature header is missing", () => {
    expect(hasUpstreamFeedbackSignature(req({ "x-iw-timestamp": "1700000000000" }))).toBe(false);
  });

  it("is false when the timestamp header is missing", () => {
    expect(hasUpstreamFeedbackSignature(req({ "x-iw-signature": "abcd" }))).toBe(false);
  });

  it("is false with no HMAC headers (normal user, or the retired x-infraweaver-upstream header)", () => {
    expect(hasUpstreamFeedbackSignature(req({ "x-infraweaver-upstream": "1" }))).toBe(false);
    expect(hasUpstreamFeedbackSignature(req({}))).toBe(false);
  });

  it("is false when either header is present but empty (fail-closed)", () => {
    expect(hasUpstreamFeedbackSignature(req({ "x-iw-timestamp": "", "x-iw-signature": "abcd" }))).toBe(false);
    expect(hasUpstreamFeedbackSignature(req({ "x-iw-timestamp": "1700000000000", "x-iw-signature": "" }))).toBe(false);
  });
});
