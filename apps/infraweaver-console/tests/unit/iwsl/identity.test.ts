/** @jest-environment node */
// Clone / identity-crisis + safe-mode decision layer (§5, §12.5). Pure logic —
// no store, no crypto: given a link's identity fields and a signature-verified
// self-reported URL, decide bind / match / mismatch and the resulting safe-mode
// state. The crypto boundary (response signature) is verified upstream; these
// tests only exercise the decision.

import {
  confirmIdentity,
  evaluateIdentity,
  isIdentitySuspended,
  normalizeSiteUrl,
  type IdentityState,
} from "@/addons/wordpress-manager/lib/iwsl-identity";

const AT = "2026-07-18T00:00:00.000Z";

describe("normalizeSiteUrl", () => {
  test("lowercases scheme + host and strips trailing slash", () => {
    expect(normalizeSiteUrl("HTTPS://Example.COM/")).toBe("https://example.com");
    expect(normalizeSiteUrl("https://example.com")).toBe("https://example.com");
  });

  test("drops default ports but keeps explicit non-default ones", () => {
    expect(normalizeSiteUrl("https://example.com:443/")).toBe("https://example.com");
    expect(normalizeSiteUrl("http://example.com:80")).toBe("http://example.com");
    expect(normalizeSiteUrl("https://example.com:8443")).toBe("https://example.com:8443");
  });

  test("strips a single trailing FQDN dot (same DNS name)", () => {
    expect(normalizeSiteUrl("https://example.com./")).toBe("https://example.com");
    expect(normalizeSiteUrl("https://example.com.:8443")).toBe("https://example.com:8443");
  });

  test("keeps a subdirectory path (part of identity) but ignores query/fragment", () => {
    expect(normalizeSiteUrl("https://example.com/blog/")).toBe("https://example.com/blog");
    expect(normalizeSiteUrl("https://example.com/blog?x=1#y")).toBe("https://example.com/blog");
  });

  test("returns null for non-http(s), empty, oversized, or non-string input", () => {
    expect(normalizeSiteUrl("ftp://example.com")).toBeNull();
    expect(normalizeSiteUrl("not a url")).toBeNull();
    expect(normalizeSiteUrl("")).toBeNull();
    expect(normalizeSiteUrl("   ")).toBeNull();
    expect(normalizeSiteUrl(`https://example.com/${"a".repeat(4096)}`)).toBeNull();
    expect(normalizeSiteUrl(undefined)).toBeNull();
    expect(normalizeSiteUrl(42)).toBeNull();
  });
});

describe("evaluateIdentity — binding", () => {
  test("first verified self-report binds the identity (TOFR), no suspension", () => {
    const decision = evaluateIdentity({}, "https://Example.com/", AT);
    expect(decision.kind).toBe("bound");
    if (decision.kind !== "bound") throw new Error("expected bound");
    expect(decision.next.canonicalUrl).toBe("https://example.com");
    expect(decision.next.identitySuspended).toBe(false);
    expect(decision.next.identityAlert).toBeUndefined();
  });

  test("binding clears a stale suspension carried on the record", () => {
    const current: IdentityState = {
      identitySuspended: true,
      identityAlert: { reason: "url-changed", observedUrl: "https://x", boundUrl: "https://y", at: AT },
    };
    const decision = evaluateIdentity(current, "https://example.com", AT);
    expect(decision.kind).toBe("bound");
    if (decision.kind !== "bound") throw new Error("expected bound");
    expect(decision.next.identitySuspended).toBe(false);
    expect(decision.next.identityAlert).toBeUndefined();
  });
});

describe("evaluateIdentity — match", () => {
  test("a report of the confirmed identity is a no-op", () => {
    const current: IdentityState = { canonicalUrl: "https://example.com" };
    const decision = evaluateIdentity(current, "https://example.com/", AT);
    expect(decision.kind).toBe("match");
  });

  test("matches through normalization differences (case, trailing slash)", () => {
    const current: IdentityState = { canonicalUrl: "https://example.com" };
    const decision = evaluateIdentity(current, "HTTPS://EXAMPLE.COM/", AT);
    expect(decision.kind).toBe("match");
  });

  test("does not clear an existing suspension on a matching report", () => {
    // A clone that flaps back to the confirmed URL must not self-heal.
    const current: IdentityState = {
      canonicalUrl: "https://example.com",
      identitySuspended: true,
      identityAlert: { reason: "url-changed", observedUrl: "https://evil.example", boundUrl: "https://example.com", at: AT },
    };
    const decision = evaluateIdentity(current, "https://example.com", AT);
    expect(decision.kind).toBe("match");
    if (decision.kind !== "match") throw new Error("expected match");
    expect(decision.next.identitySuspended).toBe(true);
    expect(decision.next.identityAlert?.observedUrl).toBe("https://evil.example");
  });
});

describe("evaluateIdentity — mismatch (clone / migration)", () => {
  test("a valid-key link reporting a different URL suspends state-changing ops", () => {
    const current: IdentityState = { canonicalUrl: "https://example.com" };
    const decision = evaluateIdentity(current, "https://clone.attacker.test", AT);
    expect(decision.kind).toBe("mismatch");
    if (decision.kind !== "mismatch") throw new Error("expected mismatch");
    expect(decision.next.identitySuspended).toBe(true);
    expect(decision.next.identityAlert).toEqual({
      reason: "url-changed",
      observedUrl: "https://clone.attacker.test",
      boundUrl: "https://example.com",
      at: AT,
    });
    // The confirmed binding is kept until the operator accepts the new one.
    expect(decision.next.canonicalUrl).toBe("https://example.com");
  });

  test("a scheme change (https → http) is a mismatch", () => {
    const current: IdentityState = { canonicalUrl: "https://example.com" };
    expect(evaluateIdentity(current, "http://example.com", AT).kind).toBe("mismatch");
  });
});

describe("evaluateIdentity — no signal (never bound)", () => {
  test("an unparseable self-report on an UNBOUND link is no-signal, not a trip", () => {
    expect(evaluateIdentity({}, "garbage", AT).kind).toBe("no-signal");
    expect(evaluateIdentity({}, undefined, AT).kind).toBe("no-signal");
  });
});

describe("evaluateIdentity — stopped-reporting regression (bound → no signal)", () => {
  test("a bound link that stops reporting a URL trips safe mode", () => {
    const current: IdentityState = { canonicalUrl: "https://example.com" };
    const decision = evaluateIdentity(current, undefined, AT);
    expect(decision.kind).toBe("mismatch");
    if (decision.kind !== "mismatch") throw new Error("expected mismatch");
    expect(decision.next.identitySuspended).toBe(true);
    expect(decision.next.identityAlert).toEqual({
      reason: "stopped-reporting",
      observedUrl: "",
      boundUrl: "https://example.com",
      at: AT,
    });
    // The confirmed binding is retained (there's no valid new URL to accept).
    expect(decision.next.canonicalUrl).toBe("https://example.com");
  });

  test("also trips on an unparseable (broken-home) self-report once bound", () => {
    const current: IdentityState = { canonicalUrl: "https://example.com" };
    expect(evaluateIdentity(current, "garbage", AT).kind).toBe("mismatch");
  });

  test("does not churn the alert once already suspended", () => {
    const current: IdentityState = {
      canonicalUrl: "https://example.com",
      identitySuspended: true,
      identityAlert: { reason: "url-changed", observedUrl: "https://a", boundUrl: "https://example.com", at: AT },
    };
    const decision = evaluateIdentity(current, undefined, "2026-07-18T02:00:00.000Z");
    expect(decision.kind).toBe("match");
    if (decision.kind !== "match") throw new Error("expected match");
    expect(decision.next.identityAlert?.observedUrl).toBe("https://a");
    expect(decision.next.identityAlert?.at).toBe(AT);
  });
});

describe("confirmIdentity", () => {
  test("accepts the observed URL that tripped the alert as the new binding", () => {
    const current: IdentityState = {
      canonicalUrl: "https://example.com",
      identitySuspended: true,
      identityAlert: { reason: "url-changed", observedUrl: "https://newhome.example", boundUrl: "https://example.com", at: AT },
    };
    const next = confirmIdentity(current);
    expect(next.canonicalUrl).toBe("https://newhome.example");
    expect(next.identitySuspended).toBe(false);
    expect(next.identityAlert).toBeUndefined();
  });

  test("falls back to the existing binding when there is no alert", () => {
    const next = confirmIdentity({ canonicalUrl: "https://example.com" });
    expect(next.canonicalUrl).toBe("https://example.com");
    expect(next.identitySuspended).toBe(false);
  });

  test("keeps the binding when confirming a stopped-reporting alert (no valid new URL)", () => {
    const current: IdentityState = {
      canonicalUrl: "https://example.com",
      identitySuspended: true,
      identityAlert: { reason: "stopped-reporting", observedUrl: "", boundUrl: "https://example.com", at: AT },
    };
    const next = confirmIdentity(current);
    expect(next.canonicalUrl).toBe("https://example.com");
    expect(next.identitySuspended).toBe(false);
    expect(next.identityAlert).toBeUndefined();
  });

  test("re-confirming lets the next matching report be a match, not a mismatch", () => {
    const suspended: IdentityState = {
      canonicalUrl: "https://example.com",
      identitySuspended: true,
      identityAlert: { reason: "url-changed", observedUrl: "https://newhome.example", boundUrl: "https://example.com", at: AT },
    };
    const reconfirmed = confirmIdentity(suspended);
    expect(evaluateIdentity(reconfirmed, "https://newhome.example", AT).kind).toBe("match");
    expect(evaluateIdentity(reconfirmed, "https://example.com", AT).kind).toBe("mismatch");
  });
});

describe("isIdentitySuspended", () => {
  test("reflects the flag", () => {
    expect(isIdentitySuspended({})).toBe(false);
    expect(isIdentitySuspended({ identitySuspended: false })).toBe(false);
    expect(isIdentitySuspended({ identitySuspended: true })).toBe(true);
  });
});
