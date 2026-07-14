/**
 * @jest-environment node
 *
 * Regression pin for the offboard/reconcile identity-drift fix (commit 539e9489).
 *
 * A username/case drift — or a post-invite rename — leaves an Authentik record the
 * username lookup can no longer see but that plainly exists under its unchanged
 * email. `resolveAuthentikIdentity` MUST fall back to the email so the SSO account
 * is actually resolved (and, for offboard, DELETEd) instead of silently orphaned.
 *
 * This drives the pure resolver with stub lookups — the same seam the offboard route,
 * the reconcile loop, and the `sec-offboard-drift` runtime self-test all share, so a
 * dropped fallback can't regress silently in any of them.
 */

jest.mock("server-only", () => ({}), { virtual: true });

// Default resolvers are imported from @/lib/authentik; stub the module so importing
// the resolver never reaches a real Authentik. Every test injects its own resolvers.
jest.mock("@/lib/authentik", () => ({
  findUserByUsername: jest.fn(async () => null),
  findUserByEmail: jest.fn(async () => null),
}));

import { resolveAuthentikIdentity } from "@/lib/users/resolve-identity";

const DRIFT_PK = 987654321;
const EMAIL = "testdrift@example.com";

describe("resolveAuthentikIdentity — username→email drift", () => {
  test("username miss + roster email → resolves the email-matched record (the pk offboard DELETEs)", async () => {
    const findUserByEmail = jest.fn(async (email: string) =>
      email === EMAIL ? { pk: DRIFT_PK, email } : null,
    );

    const resolved = await resolveAuthentikIdentity("TestDrift", EMAIL, {
      findUserByUsername: async () => null, // drifted: username no longer matches
      findUserByEmail,
    });

    expect(findUserByEmail).toHaveBeenCalledWith(EMAIL);
    expect(resolved?.pk).toBe(DRIFT_PK);
    // The resolved pk is what the offboard route feeds into DELETE /core/users/<pk>/.
    expect(`/core/users/${resolved!.pk}/`).toBe(`/core/users/${DRIFT_PK}/`);
  });

  test("username hit → returns it and NEVER consults the email fallback", async () => {
    const findUserByEmail = jest.fn(async () => {
      throw new Error("email fallback ran despite a username match");
    });

    const resolved = await resolveAuthentikIdentity("exact", EMAIL, {
      findUserByUsername: async () => ({ pk: 1, username: "exact", email: EMAIL }),
      findUserByEmail,
    });

    expect(resolved?.pk).toBe(1);
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  test("username miss + no roster email → null (nothing to resolve, no fallback attempted)", async () => {
    const findUserByEmail = jest.fn(async () => ({ pk: 5 }));

    const resolved = await resolveAuthentikIdentity("ghost", undefined, {
      findUserByUsername: async () => null,
      findUserByEmail,
    });

    expect(resolved).toBeNull();
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  test("both miss → null (no identity anywhere)", async () => {
    const resolved = await resolveAuthentikIdentity("nobody", "nobody@example.com", {
      findUserByUsername: async () => null,
      findUserByEmail: async () => null,
    });

    expect(resolved).toBeNull();
  });
});
